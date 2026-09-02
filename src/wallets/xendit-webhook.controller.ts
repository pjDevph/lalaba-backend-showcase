import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WalletsService } from './wallets.service';
import { TopUpIntentStatus } from './schemas/topup-intent.schema';
import { XenditInvoiceCallbackDto } from './dto/xendit-invoice-callback.dto';

/**
 * SEC-012 — the webhook's own rate-limit bucket.
 *
 * The global throttler is 100 requests/minute across every route. Xendit
 * retries a callback it did not get a 2xx for, so once a burst of legitimate
 * settlements crossed that shared budget the endpoint started 429-ing, which
 * Xendit reads as failure and retries — a self-amplifying storm that also
 * starved every other route of the shared allowance. The endpoint is
 * authenticated per request by a timing-safe callback token, so the useful
 * limit here is a generous ceiling that only stops genuine flooding, kept
 * separate from the interactive-traffic budget.
 */
export const XENDIT_WEBHOOK_THROTTLE = { limit: 600, ttl: 60_000 };

/**
 * REST webhook for Xendit invoice callbacks (RISK-P0-003). This is the ONLY
 * external entry point that can settle a top-up intent, and it only does so
 * after: callback-token verification (timing-safe), intent lookup by
 * external_id, and amount/currency match against the stored intent — then the
 * credit itself goes through the single transactional
 * `WalletsService.postVerifiedTopUp` path guarded by the unique ledger index.
 */
@Controller('webhooks')
export class XenditWebhookController {
  private readonly logger = new Logger(XenditWebhookController.name);

  constructor(
    private readonly walletsService: WalletsService,
    private readonly configService: ConfigService,
  ) {}

  private verifyCallbackToken(token: string | undefined): void {
    const expected = this.configService.get<string>('XENDIT_CALLBACK_TOKEN');
    if (!expected) {
      // No token configured (e.g. local dev without Xendit): the endpoint is
      // unusable rather than open — never accept unauthenticated credits.
      this.logger.warn(
        'Rejected Xendit webhook: XENDIT_CALLBACK_TOKEN is not configured',
      );
      throw new UnauthorizedException('Webhook not configured');
    }
    // Hash both sides so comparison is constant-time and length-independent.
    const a = createHash('sha256')
      .update(token ?? '')
      .digest();
    const b = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid callback token');
    }
  }

  @Post('xendit')
  @HttpCode(200)
  @Throttle({ default: XENDIT_WEBHOOK_THROTTLE })
  async handleInvoiceCallback(
    @Headers('x-callback-token') token: string | undefined,
    @Body() body: XenditInvoiceCallbackDto,
  ): Promise<{ ok: boolean; alreadyPosted?: boolean }> {
    this.verifyCallbackToken(token);

    const intentId = body?.external_id;
    const status =
      typeof body?.status === 'string' ? body.status.toUpperCase() : undefined;
    // Defence in depth behind the DTO (SEC-014): assert the primitive type
    // here too, so an operator object like {"$ne": null} can never reach the
    // intent lookup even if this handler is ever invoked without the pipe.
    if (typeof intentId !== 'string' || !intentId || !status) {
      throw new BadRequestException('Malformed webhook payload');
    }

    if (status === 'PAID' || status === 'SETTLED') {
      const paidPesos = body.paid_amount ?? body.amount;
      if (typeof paidPesos !== 'number' || !Number.isFinite(paidPesos)) {
        throw new BadRequestException('Webhook payload has no valid amount');
      }
      const result = await this.walletsService.postVerifiedTopUp(intentId, {
        reference: intentId,
        amountCentavos: Math.round(paidPesos * 100),
        currency: body.currency ?? 'PHP',
        gatewayInvoiceId: body.id ?? null,
      });
      return { ok: true, alreadyPosted: result.alreadyPosted };
    }

    if (status === 'EXPIRED') {
      await this.walletsService.resolveIntentWithoutCredit(
        intentId,
        TopUpIntentStatus.EXPIRED,
      );
      return { ok: true };
    }

    // Unknown/ignorable event type — acknowledge so Xendit stops retrying,
    // but never credit.
    this.logger.warn(
      `Ignoring Xendit webhook with unhandled status "${status}" for intent ${intentId}`,
    );
    return { ok: true };
  }
}
