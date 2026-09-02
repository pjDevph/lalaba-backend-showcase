/**
 * Payment gateway abstraction for wallet top-ups (RISK-P0-003).
 *
 * `WalletsService` never talks to Xendit directly — it asks the bound
 * `PaymentGatewayService` to create an invoice for a PENDING intent. The
 * binding is decided once at module init (see wallets.module.ts):
 *
 *   - XENDIT_SECRET_KEY set            → XenditPaymentGateway (real invoices)
 *   - no key, NODE_ENV !== 'production' → DevPaymentGateway (auto-succeeds)
 *   - no key, NODE_ENV === 'production' → module init THROWS; the app must
 *     never boot in production with a gateway that silently credits.
 *
 * SEC-002: that factory check is necessary but not sufficient — it lets
 * staging/preview deploys, and prod deploys with NODE_ENV unset, reach the
 * auto-succeed gateway. `DevPaymentGateway` therefore enforces its own
 * fail-closed opt-in (NODE_ENV=development/test, or an explicit
 * ALLOW_DEV_PAYMENT_GATEWAY=true) in its constructor and on every call, so the
 * protection does not depend on how it was wired.
 */
export interface CreateInvoiceRequest {
  /** TopUpIntent _id — sent to the gateway as external_id / reference. */
  intentId: string;
  branchId: string;
  amountCentavos: number;
  description: string;
}

export interface CreateInvoiceResult {
  /** Gateway-side invoice id (null for the dev gateway). */
  gatewayInvoiceId: string | null;
  /** Hosted checkout URL for the FE to open (null for the dev gateway). */
  invoiceUrl: string | null;
  /**
   * True only for the dev gateway: the "payment" is considered settled
   * immediately, so the caller runs the same postVerifiedTopUp path a real
   * webhook would. A real gateway always returns false.
   */
  autoSucceeds: boolean;
}

export abstract class PaymentGatewayService {
  abstract readonly name: string;
  abstract createInvoice(
    req: CreateInvoiceRequest,
  ): Promise<CreateInvoiceResult>;
}
