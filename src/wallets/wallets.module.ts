import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { WalletsService } from './wallets.service';
import { WalletsResolver } from './wallets.resolver';
import { WalletAcceptanceGuardService } from './wallet-acceptance-guard.service';
import { XenditWebhookController } from './xendit-webhook.controller';
import { PaymentGatewayService } from './gateway/payment-gateway.service';
import { XenditPaymentGateway } from './gateway/xendit-payment.gateway';
import { DevPaymentGateway } from './gateway/dev-payment.gateway';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import {
  WalletLedgerEntry,
  WalletLedgerEntrySchema,
} from './schemas/wallet-ledger-entry.schema';
import { TopUpIntent, TopUpIntentSchema } from './schemas/topup-intent.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { WalletsAdminService } from './wallets-admin.service';
import { WalletsAdminResolver } from './wallets-admin.resolver';

/**
 * Gateway binding (RISK-P0-003).
 *
 * `XENDIT_ONLINE` is the local/live switch, matching the MONGODB_ONLINE /
 * STORAGE_ONLINE convention used elsewhere. It lets you flip between the real
 * gateway and the dev auto-succeed one WITHOUT deleting your keys from .env:
 *
 *   XENDIT_ONLINE=on   → real XenditPaymentGateway (requires XENDIT_SECRET_KEY)
 *   XENDIT_ONLINE=off  → DevPaymentGateway, even when a key is present
 *   unset              → legacy behaviour: key present → real, absent → dev
 *
 * Production always uses the real gateway: `off` there is a hard error, as is
 * a missing key, because production must never fall back to a gateway that
 * credits wallets without collecting money.
 *
 * Two key/environment mismatches also refuse to boot, since both would be
 * discovered only after money (or fake money) moved:
 *   - a live `xnd_production_` key outside production → would charge real cards
 *     from a dev machine.
 *   - a test `xnd_development_` key in production → would accept fake payments
 *     from real customers.
 *
 * `XENDIT_BASE_URL` overrides the API host (sandbox mocks, contract tests).
 */
const isOn = (v: string | undefined): boolean =>
  (v ?? '').trim().toLowerCase() === 'on';
const isOff = (v: string | undefined): boolean =>
  (v ?? '').trim().toLowerCase() === 'off';

export const paymentGatewayProvider = {
  provide: PaymentGatewayService,
  useFactory: (config: ConfigService): PaymentGatewayService => {
    const logger = new Logger('PaymentGateway');
    const secretKey = config.get<string>('XENDIT_SECRET_KEY')?.trim();
    const baseUrl = config.get<string>('XENDIT_BASE_URL')?.trim();
    const online = config.get<string>('XENDIT_ONLINE');
    const isProd = process.env.NODE_ENV === 'production';

    if (isProd) {
      if (isOff(online)) {
        throw new Error(
          'XENDIT_ONLINE=off is not allowed in production — refusing to start with the dev auto-succeed payment gateway',
        );
      }
      if (!secretKey) {
        throw new Error(
          'XENDIT_SECRET_KEY is required in production — refusing to start with the dev auto-succeed payment gateway',
        );
      }
      if (secretKey.startsWith('xnd_development_')) {
        throw new Error(
          'XENDIT_SECRET_KEY is a test-mode key (xnd_development_) but NODE_ENV=production — refusing to start; real customers would be sent to a sandbox checkout',
        );
      }
    } else if (secretKey?.startsWith('xnd_production_')) {
      throw new Error(
        'XENDIT_SECRET_KEY is a LIVE key (xnd_production_) outside production — refusing to start; local top-ups would charge real cards. Replace it with a test key (xnd_development_), or clear it and set XENDIT_ONLINE=off. XENDIT_ONLINE=off alone does NOT silence this: a live key on a dev machine is a misconfiguration worth fixing either way',
      );
    }

    // Explicit `on`/`off` wins outside production; with neither set, fall back
    // to the legacy rule of "real gateway whenever a key is configured".
    const useXendit =
      isProd || isOn(online) || (!isOff(online) && Boolean(secretKey));

    if (useXendit) {
      if (!secretKey) {
        throw new Error(
          'XENDIT_ONLINE=on requires XENDIT_SECRET_KEY — refusing to start with a misconfigured payment gateway',
        );
      }
      logger.log(
        `Using Xendit${secretKey.startsWith('xnd_development_') ? ' (TEST mode)' : ' (LIVE mode)'}${baseUrl ? ` via ${baseUrl}` : ''}`,
      );
      const returnUrl = config.get<string>('XENDIT_RETURN_URL')?.trim();
      return new XenditPaymentGateway(
        secretKey,
        baseUrl || undefined,
        returnUrl || undefined,
      );
    }

    logger.warn(
      `Using DEV auto-succeed payment gateway — top-ups credit wallets without collecting money${
        secretKey ? ' (XENDIT_ONLINE=off; key present but ignored)' : ''
      }`,
    );
    return new DevPaymentGateway();
  },
  inject: [ConfigService],
};

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Wallet.name, schema: WalletSchema },
      { name: WalletLedgerEntry.name, schema: WalletLedgerEntrySchema },
      { name: TopUpIntent.name, schema: TopUpIntentSchema },
      { name: Branch.name, schema: BranchSchema },
      // Read-only, and only so the admin wallet list can name a washer by her
      // storeName the way discovery and chat do. forFeature registers the
      // model without importing WasherModule, so no module cycle.
      { name: WasherProfile.name, schema: WasherProfileSchema },
    ]),
  ],
  controllers: [XenditWebhookController],
  providers: [
    WalletsService,
    WalletsResolver,
    WalletsAdminService,
    WalletsAdminResolver,
    WalletAcceptanceGuardService,
    paymentGatewayProvider,
  ],
  exports: [WalletsService, WalletAcceptanceGuardService],
})
export class WalletsModule {}
