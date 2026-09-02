import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreateInvoiceRequest,
  CreateInvoiceResult,
  PaymentGatewayService,
} from './payment-gateway.service';

/**
 * Real Xendit Invoice API gateway. Amounts on the Xendit invoice API are in
 * whole pesos (PHP), so centavos are converted at the boundary here and the
 * webhook controller converts back — everything inside our system stays
 * integer centavos.
 *
 * NOT_PROVEN against a live Xendit sandbox in this repo (no credentials);
 * request/response shapes follow https://developers.xendit.co/api-reference/#create-invoice.
 */
@Injectable()
export class XenditPaymentGateway extends PaymentGatewayService {
  readonly name = 'xendit';
  private readonly logger = new Logger(XenditPaymentGateway.name);
  private readonly baseUrl: string;

  private readonly returnUrl: string | null;

  constructor(
    private readonly secretKey: string,
    baseUrl: string = 'https://api.xendit.co',
    /**
     * Where Xendit sends the browser once checkout finishes — normally the
     * partner app's deep link (XENDIT_RETURN_URL, e.g. `lalaba-merchant://wallet`).
     * Without it the payer is stranded on Xendit's own receipt page with no way
     * back into the app, which is what "paid but nothing happened" looks like.
     *
     * This is presentation only: it never settles anything. The wallet is still
     * credited exclusively by the verified webhook, so a payer who closes the
     * tab instead of following the redirect is not treated differently.
     */
    returnUrl?: string,
  ) {
    super();
    // Trailing slashes would produce `//v2/invoices`; normalise once here so
    // XENDIT_BASE_URL can be pasted in either form.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.returnUrl = returnUrl?.trim() || null;
    if (!this.returnUrl) {
      this.logger.warn(
        "XENDIT_RETURN_URL is not set — payers will be left on Xendit's receipt page with no route back into the app",
      );
    }
  }

  /**
   * Appends `intent` + `result` to the configured return URL. Uses manual
   * string building rather than `new URL()` because the return URL is normally
   * a custom app scheme (`lalaba-merchant://wallet`), which URL() parses as an
   * opaque path and re-serialises in a form the OS no longer routes.
   */
  private withIntent(intentId: string, result: 'success' | 'failure'): string {
    const base = this.returnUrl!;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}intent=${encodeURIComponent(intentId)}&result=${result}`;
  }

  async createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/invoices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
        },
        body: JSON.stringify({
          external_id: req.intentId,
          amount: req.amountCentavos / 100, // Xendit expects whole pesos
          currency: 'PHP',
          description: req.description,
          // Both branches return to the same place: the app re-reads the intent
          // via `topUpStatus` and shows the outcome from OUR record, never from
          // which redirect fired. The intent id rides along so the app knows
          // which top-up to check after a cold start.
          ...(this.returnUrl
            ? {
                success_redirect_url: this.withIntent(req.intentId, 'success'),
                failure_redirect_url: this.withIntent(req.intentId, 'failure'),
              }
            : {}),
        }),
      });
    } catch (err) {
      this.logger.error(
        `Xendit invoice request failed for intent ${req.intentId}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: 'Payment gateway is unreachable. Please try again shortly.',
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(
        `Xendit invoice creation rejected for intent ${req.intentId}: HTTP ${res.status} ${body.slice(0, 500)}`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message:
          'Payment gateway rejected the top-up request. Please try again shortly.',
      });
    }

    const invoice = (await res.json()) as { id: string; invoice_url: string };
    return {
      gatewayInvoiceId: invoice.id,
      invoiceUrl: invoice.invoice_url,
      autoSucceeds: false,
    };
  }
}
