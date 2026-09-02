import { Injectable, Logger } from '@nestjs/common';
import {
  CreateInvoiceRequest,
  CreateInvoiceResult,
  PaymentGatewayService,
} from './payment-gateway.service';

/**
 * ⚠️ DEV-ONLY payment gateway — NEVER bound outside local development.
 *
 * SEC-002. The module factory only refuses the dev gateway when NODE_ENV is
 * *exactly* 'production', which means a staging/preview deploy — or a real
 * production deploy that simply forgot to set NODE_ENV — silently binds a
 * gateway that credits wallet balance without collecting money. Any merchant
 * could then mint the ₱1,000 activation threshold and buy marketplace
 * visibility for free.
 *
 * The guard therefore lives HERE, in the dangerous class itself, so it holds
 * no matter which factory or DI wiring constructs it, and it fails CLOSED:
 * unset, unknown or prod-like NODE_ENV values are refused. Enabling the
 * auto-succeed gateway anywhere other than a developer machine now requires a
 * deliberate, greppable act:
 *
 *   ALLOW_DEV_PAYMENT_GATEWAY=true
 *
 * The assertion runs both at construction (so a misconfigured deploy aborts at
 * boot rather than at the first top-up) and again on every createInvoice call
 * (so a long-lived process cannot keep minting balance if the instance was
 * built some other way).
 */
export const ALLOW_DEV_PAYMENT_GATEWAY_ENV = 'ALLOW_DEV_PAYMENT_GATEWAY';

/**
 * NODE_ENV values in which the auto-succeed gateway may run without an
 * explicit opt-in. 'development' is a developer machine; 'test' is what Jest
 * sets for itself and is never a deployed configuration. Everything else —
 * including undefined, 'staging', 'preview' and 'production' — is refused.
 */
const IMPLICITLY_SAFE_NODE_ENVS: ReadonlySet<string> = new Set([
  'development',
  'test',
]);

export function assertDevPaymentGatewayAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const optIn = (env[ALLOW_DEV_PAYMENT_GATEWAY_ENV] ?? '').trim().toLowerCase();
  if (optIn === 'true') return;

  const nodeEnv = (env.NODE_ENV ?? '').trim();
  if (IMPLICITLY_SAFE_NODE_ENVS.has(nodeEnv)) return;

  throw new Error(
    `Refusing to use the dev auto-succeed payment gateway: NODE_ENV=${
      nodeEnv || '(unset)'
    } is not a development environment. This gateway credits wallet balance ` +
      'without collecting money. Configure XENDIT_SECRET_KEY for this ' +
      `deployment, or set ${ALLOW_DEV_PAYMENT_GATEWAY_ENV}=true if you really ` +
      'intend to run without a payment processor.',
  );
}

@Injectable()
export class DevPaymentGateway extends PaymentGatewayService {
  readonly name = 'dev-auto-succeed';
  private readonly logger = new Logger(DevPaymentGateway.name);

  constructor() {
    super();
    assertDevPaymentGatewayAllowed();
  }

  async createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
    // Re-checked per call: construction-time state is not a safe proxy for the
    // environment a long-running process is actually serving.
    assertDevPaymentGatewayAllowed();
    this.logger.warn(
      `DEV payment gateway auto-succeeding top-up intent ${req.intentId} (₱${(req.amountCentavos / 100).toFixed(2)}) — no real payment collected`,
    );
    return Promise.resolve({
      gatewayInvoiceId: null,
      invoiceUrl: null,
      autoSucceeds: true,
    });
  }
}
