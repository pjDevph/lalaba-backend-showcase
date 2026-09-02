import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XenditWebhookController } from './xendit-webhook.controller';
import { WalletsService } from './wallets.service';
import { TopUpIntentStatus } from './schemas/topup-intent.schema';

const CALLBACK_TOKEN = 'test-callback-token-123';

describe('XenditWebhookController (unit)', () => {
  let controller: XenditWebhookController;
  let walletsService: {
    postVerifiedTopUp: jest.Mock;
    resolveIntentWithoutCredit: jest.Mock;
  };
  let configuredToken: string | undefined;

  const makeController = () => {
    walletsService = {
      postVerifiedTopUp: jest
        .fn()
        .mockResolvedValue({ alreadyPosted: false, intent: {} }),
      resolveIntentWithoutCredit: jest.fn().mockResolvedValue({}),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'XENDIT_CALLBACK_TOKEN' ? configuredToken : undefined,
      ),
    } as unknown as ConfigService;
    controller = new XenditWebhookController(
      walletsService as unknown as WalletsService,
      configService,
    );
  };

  const paidBody = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv_abc',
    external_id: 'intent-1',
    status: 'PAID',
    amount: 1000,
    paid_amount: 1000,
    currency: 'PHP',
    ...overrides,
  });

  beforeEach(() => {
    configuredToken = CALLBACK_TOKEN;
    makeController();
  });

  it('[NEG] rejects a missing callback token', async () => {
    await expect(
      controller.handleInvoiceCallback(undefined, paidBody()),
    ).rejects.toThrow(UnauthorizedException);
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[NEG] rejects a wrong callback token', async () => {
    await expect(
      controller.handleInvoiceCallback('wrong-token', paidBody()),
    ).rejects.toThrow(UnauthorizedException);
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[NEG] rejects every request when no token is configured (endpoint closed, never open)', async () => {
    configuredToken = undefined;
    makeController();
    await expect(
      controller.handleInvoiceCallback(CALLBACK_TOKEN, paidBody()),
    ).rejects.toThrow(UnauthorizedException);
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[HP] PAID event posts through postVerifiedTopUp with pesos converted to centavos', async () => {
    const res = await controller.handleInvoiceCallback(
      CALLBACK_TOKEN,
      paidBody({ paid_amount: 1000 }),
    );
    expect(res).toEqual({ ok: true, alreadyPosted: false });
    expect(walletsService.postVerifiedTopUp).toHaveBeenCalledWith('intent-1', {
      reference: 'intent-1',
      amountCentavos: 100_000,
      currency: 'PHP',
      gatewayInvoiceId: 'inv_abc',
    });
  });

  it('[HP] EXPIRED event resolves the intent without credit', async () => {
    const res = await controller.handleInvoiceCallback(
      CALLBACK_TOKEN,
      paidBody({ status: 'EXPIRED' }),
    );
    expect(res).toEqual({ ok: true });
    expect(walletsService.resolveIntentWithoutCredit).toHaveBeenCalledWith(
      'intent-1',
      TopUpIntentStatus.EXPIRED,
    );
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[NEG] rejects a payload without external_id or status', async () => {
    await expect(
      controller.handleInvoiceCallback(CALLBACK_TOKEN, { status: 'PAID' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.handleInvoiceCallback(CALLBACK_TOKEN, {
        external_id: 'intent-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('[NEG] rejects a PAID payload without a numeric amount', async () => {
    await expect(
      controller.handleInvoiceCallback(
        CALLBACK_TOKEN,
        paidBody({ paid_amount: undefined, amount: undefined }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[HP] unknown statuses are acknowledged but never credited', async () => {
    const res = await controller.handleInvoiceCallback(
      CALLBACK_TOKEN,
      paidBody({ status: 'PENDING' }),
    );
    expect(res).toEqual({ ok: true });
    expect(walletsService.postVerifiedTopUp).not.toHaveBeenCalled();
    expect(walletsService.resolveIntentWithoutCredit).not.toHaveBeenCalled();
  });
});
