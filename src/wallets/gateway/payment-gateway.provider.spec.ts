import { ConfigService } from '@nestjs/config';
import { paymentGatewayProvider } from '../wallets.module';
import { XenditPaymentGateway } from './xendit-payment.gateway';
import { DevPaymentGateway } from './dev-payment.gateway';

/**
 * The gateway factory decides whether wallet top-ups collect real money, so
 * every branch of the local/live switch is pinned here — including the
 * refuse-to-boot cases, which exist precisely because their failure mode is
 * only discovered after money (or fake money) has moved.
 */
describe('paymentGatewayProvider', () => {
  const TEST_KEY = 'xnd_development_abc123';
  const LIVE_KEY = 'xnd_production_abc123';
  const originalNodeEnv = process.env.NODE_ENV;

  const build = (env: Record<string, string | undefined>) =>
    paymentGatewayProvider.useFactory({
      get: (key: string) => env[key],
    } as unknown as ConfigService);

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('outside production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('binds the dev gateway when no key is configured', () => {
      expect(build({})).toBeInstanceOf(DevPaymentGateway);
    });

    it('binds Xendit when a test key is configured and no switch is set', () => {
      expect(build({ XENDIT_SECRET_KEY: TEST_KEY })).toBeInstanceOf(
        XenditPaymentGateway,
      );
    });

    it('binds the dev gateway when XENDIT_ONLINE=off, keeping the key in .env', () => {
      expect(
        build({ XENDIT_SECRET_KEY: TEST_KEY, XENDIT_ONLINE: 'off' }),
      ).toBeInstanceOf(DevPaymentGateway);
    });

    it('accepts ON/Off casing and surrounding whitespace', () => {
      expect(
        build({ XENDIT_SECRET_KEY: TEST_KEY, XENDIT_ONLINE: ' OFF ' }),
      ).toBeInstanceOf(DevPaymentGateway);
      expect(
        build({ XENDIT_SECRET_KEY: TEST_KEY, XENDIT_ONLINE: 'On' }),
      ).toBeInstanceOf(XenditPaymentGateway);
    });

    it('throws when XENDIT_ONLINE=on but no key is configured', () => {
      expect(() => build({ XENDIT_ONLINE: 'on' })).toThrow(
        /requires XENDIT_SECRET_KEY/,
      );
    });

    it('refuses to boot with a LIVE key outside production', () => {
      expect(() => build({ XENDIT_SECRET_KEY: LIVE_KEY })).toThrow(
        /LIVE key .* outside production/,
      );
    });

    it('still refuses a LIVE key even when switched off', () => {
      // Guard must not be bypassable by the switch — a live key on a dev box
      // is a misconfiguration worth failing loudly on either way.
      expect(() =>
        build({ XENDIT_SECRET_KEY: LIVE_KEY, XENDIT_ONLINE: 'off' }),
      ).toThrow(/LIVE key/);
    });
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('binds Xendit with a live key', () => {
      expect(build({ XENDIT_SECRET_KEY: LIVE_KEY })).toBeInstanceOf(
        XenditPaymentGateway,
      );
    });

    it('refuses to boot without a key', () => {
      expect(() => build({})).toThrow(/XENDIT_SECRET_KEY is required/);
    });

    it('refuses to boot with XENDIT_ONLINE=off', () => {
      expect(() =>
        build({ XENDIT_SECRET_KEY: LIVE_KEY, XENDIT_ONLINE: 'off' }),
      ).toThrow(/not allowed in production/);
    });

    it('refuses to boot with a test-mode key', () => {
      expect(() => build({ XENDIT_SECRET_KEY: TEST_KEY })).toThrow(
        /test-mode key/,
      );
    });
  });
});
