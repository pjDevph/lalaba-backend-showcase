/**
 * SECURITY REGRESSION SUITE — Agent 12 (independent adversarial review).
 *
 * Written by a reviewer who did NOT implement the hardening. Two kinds of
 * test live here, and the distinction matters:
 *
 *   [DEFENCE]  asserts a control that currently HOLDS. If one of these ever
 *              fails, a real protection has regressed.
 *
 *   [FINDING]  a *characterisation* test pinning down behaviour this review
 *              judged UNSAFE (see docs/release-evidence/phase2/agent-security/
 *              FINDINGS.md). It asserts what the code does today so the suite
 *              stays green, and it is written so that FIXING the defect makes
 *              the test fail loudly — that is the signal to invert the
 *              assertion and close the finding. Never "fix" one of these by
 *              deleting it.
 */
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { paymentGatewayProvider } from '../wallets/wallets.module';
import { DevPaymentGateway } from '../wallets/gateway/dev-payment.gateway';
import { XenditPaymentGateway } from '../wallets/gateway/xendit-payment.gateway';
import {
  XenditWebhookController,
  XENDIT_WEBHOOK_THROTTLE,
} from '../wallets/xendit-webhook.controller';
import { XenditInvoiceCallbackDto } from '../wallets/dto/xendit-invoice-callback.dto';
import { WalletAcceptanceGuardService } from '../wallets/wallet-acceptance-guard.service';
import { WalletLedgerEntrySchema } from '../wallets/schemas/wallet-ledger-entry.schema';
import { TopUpIntentStatus } from '../wallets/schemas/topup-intent.schema';

import {
  MediaService,
  PUBLIC_MEDIA_FOLDER_ALLOWLIST,
} from '../media/media.service';
import { activeCourierLeg } from '../online-orders/courier-access.util';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import { OnlineOrdersService } from '../online-orders/online-orders.service';
import { calculatePlatformFee } from '../online-orders/pricing.util';
import { ChatService } from '../chat/chat.service';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { RolesResolver } from '../roles/roles.resolver';
import { MediaResolver } from '../media/media.resolver';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION_CATALOGUE } from '../permissions/permission-catalogue';
import { RolesService } from '../roles/roles.service';
import { SELF_REGISTRABLE_ROLE_IDS } from '../roles/self-registrable-roles';
import {
  OWNER_DEFAULT_PERMISSION_NAMES,
  STAFF_DEFAULT_PERMISSION_NAMES,
} from '../permissions/role-defaults';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const configWith = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

const buildGateway = (values: Record<string, string | undefined>) =>
  paymentGatewayProvider.useFactory(configWith(values));

/** Guard metadata actually attached to a resolver method by Nest. */
const guardsOn = (target: any, method?: string): any[] =>
  Reflect.getMetadata(
    '__guards__',
    method ? target.prototype[method] : target,
  ) ?? [];

const rolesOn = (target: any, method?: string): string[] | undefined =>
  Reflect.getMetadata(ROLES_KEY, method ? target.prototype[method] : target);

/** A real PNG signature — uploads are content-sniffed now (SEC-006), so the
 * storage tests must present bytes that genuinely are what they claim. */
const PNG_MAGIC = '\x89PNG\r\n\x1a\n';

// ===========================================================================
// MONEY — top-up gateway selection
// ===========================================================================

describe('SEC / money / payment gateway binding', () => {
  const realNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  });

  it('[DEFENCE] binds the real Xendit gateway whenever a secret key is present', () => {
    process.env.NODE_ENV = 'production';
    expect(buildGateway({ XENDIT_SECRET_KEY: 'xnd_live_abc' })).toBeInstanceOf(
      XenditPaymentGateway,
    );
  });

  it('[DEFENCE] refuses to boot in production without a Xendit secret key', () => {
    process.env.NODE_ENV = 'production';
    expect(() => buildGateway({})).toThrow(/XENDIT_SECRET_KEY is required/i);
  });

  const realOptIn = process.env.ALLOW_DEV_PAYMENT_GATEWAY;
  afterEach(() => {
    if (realOptIn === undefined) delete process.env.ALLOW_DEV_PAYMENT_GATEWAY;
    else process.env.ALLOW_DEV_PAYMENT_GATEWAY = realOptIn;
  });

  it('[DEFENCE SEC-002 FIXED] a NON-production NODE_ENV with no key is REFUSED, not silently auto-succeeded', () => {
    // Was [FINDING SEC-002]: the only thing standing between a deployed
    // environment and a gateway that mints wallet balance without collecting
    // money was the exact string 'production' in NODE_ENV, so a
    // staging/preview deploy — or a prod deploy that simply forgot to set
    // NODE_ENV — bound the auto-succeed gateway. DevPaymentGateway now
    // enforces its own opt-in and fails CLOSED on both.
    process.env.NODE_ENV = 'staging';
    expect(() => buildGateway({})).toThrow(/dev auto-succeed payment gateway/i);

    delete process.env.NODE_ENV; // NODE_ENV entirely unset
    expect(() => buildGateway({})).toThrow(/dev auto-succeed payment gateway/i);
  });

  it('[DEFENCE SEC-002 FIXED] the dev gateway is reachable only via an explicit, greppable opt-in', () => {
    process.env.NODE_ENV = 'staging';
    process.env.ALLOW_DEV_PAYMENT_GATEWAY = 'true';
    expect(buildGateway({})).toBeInstanceOf(DevPaymentGateway);

    // …and nothing weaker than a literal "true" counts.
    for (const weak of ['1', 'yes', 'TRUE ', '', 'false']) {
      process.env.ALLOW_DEV_PAYMENT_GATEWAY = weak;
      if (weak === 'TRUE ') {
        // trimmed + case-insensitive on purpose — a stray space is still intent
        expect(buildGateway({})).toBeInstanceOf(DevPaymentGateway);
        continue;
      }
      expect(() => buildGateway({})).toThrow();
    }
  });

  it('[DEFENCE SEC-002 FIXED] a local development environment still works end to end', () => {
    process.env.NODE_ENV = 'development';
    expect(buildGateway({})).toBeInstanceOf(DevPaymentGateway);
  });

  it('[DEFENCE SEC-002 FIXED] the auto-succeed path is re-checked per call, not only at construction', async () => {
    process.env.NODE_ENV = 'development';
    const gateway = new DevPaymentGateway();
    const req = {
      intentId: 'intent-1',
      branchId: 'branch-1',
      amountCentavos: 100_000,
      description: 'x',
    };
    // autoSucceeds:true is what makes WalletsService.initializeTopUp call
    // postVerifiedTopUp directly, with no gateway event at all — so an
    // instance that outlives its environment must stop minting balance.
    expect((await gateway.createInvoice(req)).autoSucceeds).toBe(true);

    process.env.NODE_ENV = 'production';
    await expect(gateway.createInvoice(req)).rejects.toThrow(
      /dev auto-succeed payment gateway/i,
    );
  });

  it('[DEFENCE] an empty-string secret key is treated as absent, not as a valid key', () => {
    process.env.NODE_ENV = 'production';
    expect(() => buildGateway({ XENDIT_SECRET_KEY: '' })).toThrow();
  });
});

// ===========================================================================
// MONEY — webhook authentication and credit preconditions
// ===========================================================================

describe('SEC / money / Xendit webhook', () => {
  const makeController = (
    token: string | undefined,
    wallets: Partial<Record<string, jest.Mock>> = {},
  ) =>
    new XenditWebhookController(
      {
        postVerifiedTopUp: jest.fn(),
        resolveIntentWithoutCredit: jest.fn(),
        ...wallets,
      } as any,
      configWith({ XENDIT_CALLBACK_TOKEN: token }),
    );

  const paid = { external_id: 'intent-1', status: 'PAID', amount: 1000 };

  it('[DEFENCE] rejects a callback with no token', async () => {
    await expect(
      makeController('secret').handleInvoiceCallback(undefined, paid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('[DEFENCE] rejects a callback with a wrong token', async () => {
    await expect(
      makeController('secret').handleInvoiceCallback('not-the-secret', paid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('[DEFENCE] a token prefix does not pass the comparison (length-independent compare)', async () => {
    await expect(
      makeController('secret').handleInvoiceCallback('sec', paid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('[DEFENCE] fails CLOSED when no callback token is configured — never open', async () => {
    await expect(
      makeController(undefined).handleInvoiceCallback('anything', paid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // and specifically: an empty configured token must not match an empty header
    await expect(
      makeController('').handleInvoiceCallback('', paid),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('[DEFENCE] never credits on a non-PAID status, and never invents an amount', async () => {
    const postVerifiedTopUp = jest.fn();
    const resolveIntentWithoutCredit = jest.fn();
    const c = makeController('secret', {
      postVerifiedTopUp,
      resolveIntentWithoutCredit,
    });

    await c.handleInvoiceCallback('secret', {
      external_id: 'i1',
      status: 'EXPIRED',
    });
    expect(postVerifiedTopUp).not.toHaveBeenCalled();
    expect(resolveIntentWithoutCredit).toHaveBeenCalledWith(
      'i1',
      TopUpIntentStatus.EXPIRED,
    );

    // An unknown status is acknowledged but must not credit.
    await c.handleInvoiceCallback('secret', {
      external_id: 'i1',
      status: 'PENDING',
    });
    expect(postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[DEFENCE] rejects a PAID callback that carries no usable amount', async () => {
    const postVerifiedTopUp = jest.fn();
    const c = makeController('secret', { postVerifiedTopUp });
    await expect(
      c.handleInvoiceCallback('secret', { external_id: 'i1', status: 'PAID' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postVerifiedTopUp).not.toHaveBeenCalled();
  });

  it('[DEFENCE] forwards the reference from external_id only — it is never client-chosen elsewhere', async () => {
    const postVerifiedTopUp = jest.fn().mockResolvedValue({
      alreadyPosted: false,
      intent: {},
    });
    const c = makeController('secret', { postVerifiedTopUp });
    await c.handleInvoiceCallback('secret', {
      id: 'inv_9',
      external_id: 'intent-42',
      status: 'PAID',
      amount: 250.5,
      currency: 'PHP',
    });
    expect(postVerifiedTopUp).toHaveBeenCalledWith('intent-42', {
      reference: 'intent-42',
      amountCentavos: 25_050,
      currency: 'PHP',
      gatewayInvoiceId: 'inv_9',
    });
  });
});

// ===========================================================================
// MONEY — ledger idempotency constraint
// ===========================================================================

describe('SEC / money / ledger idempotency', () => {
  it('[DEFENCE] the ledger declares a UNIQUE partial index on (branchId, xenditReference)', () => {
    // This DB-level constraint is the only thing that stops two genuinely
    // concurrent webhook deliveries from both inserting a credit row.
    const unique = WalletLedgerEntrySchema.indexes().find(
      ([fields, options]: any) =>
        fields.branchId === 1 &&
        fields.xenditReference === 1 &&
        options?.unique === true,
    );
    expect(unique).toBeDefined();
    // Partial, so fee-consumption rows (xenditReference: null) don't collide.
    expect((unique as any)[1].partialFilterExpression).toEqual({
      xenditReference: { $type: 'string' },
    });
  });
});

// ===========================================================================
// MONEY — wallet acceptance gate applies to BOTH provider types
// ===========================================================================

describe('SEC / money / wallet acceptance gate', () => {
  const guardWith = (wallet: any) =>
    new WalletAcceptanceGuardService({
      findOne: () => ({ exec: () => Promise.resolve(wallet) }),
    } as any);

  it('[DEFENCE] blocks acceptance on a negative balance', async () => {
    await expect(
      guardWith({ balanceCentavos: -1 }).assertCanAcceptOrder('b1', 0),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[DEFENCE] blocks acceptance when the balance cannot cover the fee', async () => {
    await expect(
      guardWith({ balanceCentavos: 999 }).assertCanAcceptOrder('b1', 1000),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[DEFENCE] treats a MISSING wallet as insufficient, not as unlimited', async () => {
    await expect(
      guardWith(null).assertCanAcceptOrder('b1', 0),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[DEFENCE] allows acceptance when the balance exactly covers the fee', async () => {
    await expect(
      guardWith({ balanceCentavos: 1000 }).assertCanAcceptOrder('b1', 1000),
    ).resolves.toBeUndefined();
  });

  it('[DEFENCE] the gate is provider-type agnostic — it only ever sees a branchId', () => {
    // Structural guarantee behind GAP-P0-004: the gate takes (branchId, fee)
    // and nothing else — there is no providerType parameter, so no caller can
    // scope it to washers only. And online-orders calls it unconditionally,
    // OUTSIDE the `providerType === WASHER` branch.
    const descriptor = Object.getOwnPropertyDescriptor(
      WalletAcceptanceGuardService.prototype,
      'assertCanAcceptOrder',
    );
    expect(descriptor?.value).toHaveLength(2);

    const ordersSrc = readFileSync(
      join(__dirname, '../online-orders/online-orders.service.ts'),
      'utf8',
    );
    const acceptOrder = ordersSrc.slice(
      ordersSrc.indexOf('async acceptOrder('),
    );
    const gateAt = acceptOrder.indexOf(
      'walletAcceptanceGuard.assertCanAcceptOrder',
    );
    const washerBranchAt = acceptOrder.indexOf(
      'providerType === ProviderType.WASHER',
    );
    expect(gateAt).toBeGreaterThan(-1);
    // The gate runs BEFORE the first washer-only branch, so it cannot be
    // nested inside it.
    expect(gateAt).toBeLessThan(washerBranchAt);
  });
});

// ===========================================================================
// STORAGE — public-media folder allowlist
// ===========================================================================

describe('SEC / storage / uploadMedia folder allowlist', () => {
  const uploads: Array<{ key: string }> = [];
  const service = new MediaService({
    upload: (_b: Buffer, key: string) => {
      uploads.push({ key });
      return Promise.resolve(`http://public/${key}`);
    },
    uploadPrivate: jest.fn(),
    getSignedReadUrl: jest.fn(),
    delete: jest.fn(),
  });

  const png = Buffer.from(PNG_MAGIC, 'latin1').toString('base64');
  const reject = (folder: string) =>
    expect(
      service.uploadBase64(png, 'image/png', folder),
    ).rejects.toBeInstanceOf(BadRequestException);

  it.each([
    ['parent traversal', '../kyc'],
    ['nested traversal', 'branding/../../kyc'],
    ['embedded traversal', 'uploads/../kyc'],
    ['absolute path', '/kyc'],
    ['percent-encoded traversal', '%2e%2e/kyc'],
    ['percent-encoded separator', 'branding%2f..%2fkyc'],
    ['backslash separator', 'branding\\..\\kyc'],
    ['null byte', 'branding /kyc'],
    ['unlisted root', 'kyc'],
    ['unlisted private root', 'private-evidence/x'],
    ['unlisted root with allowlisted child', 'kyc/branding'],
    ['uppercase evasion of the allowlist', 'BRANDING'],
    ['mixed case evasion', 'Uploads'],
    ['empty', ''],
    ['whitespace', ' '],
    ['dot segment', './branding'],
  ])('[DEFENCE] rejects %s', async (_label, folder) => {
    await reject(folder);
  });

  it('[DEFENCE] every allowlisted root is accepted and writes under that root', async () => {
    for (const root of PUBLIC_MEDIA_FOLDER_ALLOWLIST) {
      uploads.length = 0;
      await service.uploadBase64(png, 'image/png', root);
      expect(uploads[0].key.startsWith(`${root}/`)).toBe(true);
    }
  });

  it('[DEFENCE] a nested path under an allowlisted root stays under that root', async () => {
    uploads.length = 0;
    await service.uploadBase64(png, 'image/png', 'uploads/kyc/looks-private');
    // Even this "kyc-looking" path is written to the PUBLIC bucket via
    // upload(), never uploadPrivate() — it cannot reach the evidence bucket.
    expect(uploads[0].key.startsWith('uploads/')).toBe(true);
  });

  it('[DEFENCE SEC-006 FIXED] uploadMedia is restricted to the provider-side roles that need it', () => {
    // Was [FINDING SEC-006]: authenticated but unrestricted by role, so ANY
    // account — including every customer — could write attacker-controlled
    // bytes to the public bucket.
    expect(guardsOn(MediaResolver).length).toBeGreaterThan(0);
    const roles = rolesOn(MediaResolver);
    expect(roles).toBeDefined();
    expect(roles).toEqual(expect.arrayContaining(['merchant', 'washer']));
    expect(roles).not.toContain('customer');
    expect(roles).not.toContain('courier');
  });
});

// ===========================================================================
// STORAGE — declared MIME must match the real bytes (SEC-006)
// ===========================================================================

describe('SEC / storage / uploadMedia content sniffing', () => {
  const service = new MediaService({
    upload: (_b: Buffer, key: string) =>
      Promise.resolve(`http://public/${key}`),
    uploadPrivate: jest.fn(),
    getSignedReadUrl: jest.fn(),
    delete: jest.fn(),
  });

  const b64 = (bytes: number[] | string) =>
    (typeof bytes === 'string'
      ? Buffer.from(bytes, 'latin1')
      : Buffer.from(bytes)
    ).toString('base64');

  it('[DEFENCE SEC-006 FIXED] a payload whose bytes contradict the declared MIME is rejected', async () => {
    // The classic: HTML/script declared as an image so it lands on the public
    // origin under a .png name.
    await expect(
      service.uploadBase64(
        b64('<html><script>alert(1)</script></html>'),
        'image/png',
        'branding',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'SVG declared as PNG',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'image/png',
    ],
    ['PDF declared as JPEG', '%PDF-1.7\n', 'image/jpeg'],
    ['PNG declared as PDF', PNG_MAGIC, 'application/pdf'],
    ['empty-ish bytes declared as WEBP', 'ab', 'image/webp'],
  ])('[DEFENCE SEC-006 FIXED] rejects %s', async (_label, bytes, mime) => {
    await expect(
      service.uploadBase64(b64(bytes as any), mime, 'branding'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[DEFENCE SEC-006 FIXED] genuine files of each accepted image type still upload', async () => {
    await expect(
      service.uploadBase64(b64(PNG_MAGIC), 'image/png', 'branding'),
    ).resolves.toContain('branding/');
    await expect(
      service.uploadBase64(
        b64([0xff, 0xd8, 0xff, 0xe0]),
        'image/jpeg',
        'branding',
      ),
    ).resolves.toContain('branding/');
    await expect(
      service.uploadBase64(b64('GIF89a....'), 'image/gif', 'branding'),
    ).resolves.toContain('branding/');
    await expect(
      service.uploadBase64(b64('RIFF____WEBPVP8 '), 'image/webp', 'branding'),
    ).resolves.toContain('branding/');
  });
});

// ===========================================================================
// PRIVACY — courier access window
// ===========================================================================

describe('SEC / privacy / courier live-leg window', () => {
  const RIDER = 'rider-1';
  const OTHER = 'rider-2';
  const order = (status: OrderStatus, pickupUid = RIDER, returnUid = RIDER) =>
    ({
      status,
      pickupAssignment: { assignedStaffUid: pickupUid },
      returnAssignment: { assignedStaffUid: returnUid },
    }) as any;

  it('[DEFENCE] no access BEFORE the leg starts (assigned but not en route)', () => {
    expect(
      activeCourierLeg(order(OrderStatus.PICKUP_ASSIGNED), RIDER),
    ).toBeNull();
    expect(
      activeCourierLeg(order(OrderStatus.RETURN_ASSIGNED), RIDER),
    ).toBeNull();
  });

  it('[DEFENCE] access DURING the live window only', () => {
    expect(activeCourierLeg(order(OrderStatus.PICKUP_EN_ROUTE), RIDER)).toBe(
      'pickup',
    );
    expect(activeCourierLeg(order(OrderStatus.PICKUP_ARRIVED), RIDER)).toBe(
      'pickup',
    );
    expect(activeCourierLeg(order(OrderStatus.RETURN_EN_ROUTE), RIDER)).toBe(
      'return',
    );
    expect(activeCourierLeg(order(OrderStatus.RETURN_ARRIVED), RIDER)).toBe(
      'return',
    );
  });

  it('[DEFENCE] no access AFTER the leg completes', () => {
    for (const s of [
      OrderStatus.PICKED_UP_FROM_CUSTOMER,
      OrderStatus.LAUNDRY_IN_PROGRESS,
      OrderStatus.DELIVERED_TO_CUSTOMER,
      OrderStatus.COMPLETED,
    ]) {
      expect(activeCourierLeg(order(s), RIDER)).toBeNull();
    }
  });

  it('[DEFENCE] no access after REASSIGNMENT to a different courier', () => {
    const reassigned = order(OrderStatus.PICKUP_EN_ROUTE, OTHER, OTHER);
    expect(activeCourierLeg(reassigned, RIDER)).toBeNull();
    expect(activeCourierLeg(reassigned, OTHER)).toBe('pickup');
  });

  it('[DEFENCE] an UNRELATED courier never gets a window', () => {
    expect(
      activeCourierLeg(
        order(OrderStatus.PICKUP_EN_ROUTE, 'someone-else', 'someone-else'),
        RIDER,
      ),
    ).toBeNull();
  });

  it('[DEFENCE] the window is per leg — the pickup rider gets nothing during the return leg', () => {
    const o = order(OrderStatus.RETURN_EN_ROUTE, RIDER, OTHER);
    expect(activeCourierLeg(o, RIDER)).toBeNull();
    expect(activeCourierLeg(o, OTHER)).toBe('return');
  });

  it('[DEFENCE] an empty uid never matches an unassigned leg', () => {
    const o = {
      status: OrderStatus.PICKUP_EN_ROUTE,
      pickupAssignment: {},
      returnAssignment: {},
    } as any;
    expect(activeCourierLeg(o, '')).toBeNull();
  });
});

// ===========================================================================
// PRIVACY — unredacted doorstep coordinates (CONFIRMED FINDING)
// ===========================================================================

describe('SEC / privacy / attempt-evidence coordinates', () => {
  const resolverSrc = readFileSync(
    join(__dirname, '../online-orders/online-orders.resolver.ts'),
    'utf8',
  );
  /** Names of every @ResolveField declared on OnlineOrdersResolver. */
  const onlineOrderFieldResolvers = (): string[] =>
    [...resolverSrc.matchAll(/@ResolveField\([\s\S]*?name:\s*'(\w+)'/g)].map(
      (m) => m[1],
    );

  it('[DEFENCE] the customer snapshot PII IS routed through a redacting field resolver', () => {
    expect(onlineOrderFieldResolvers()).toEqual(
      expect.arrayContaining(['customer', 'contactPhone']),
    );
  });

  it('[DEFENCE SEC-001 FIXED] the attempt arrays now route through redacting field resolvers', () => {
    // Was [FINDING SEC-001]: pickupAttempts/deliveryAttempts were plain
    // fields with no resolver, so the house-level gpsLat/gpsLng recorded on a
    // failed attempt bypassed the redaction protecting customer.mapLocation.
    const resolvers = onlineOrderFieldResolvers();
    expect(resolvers).toContain('pickupAttempts');
    expect(resolvers).toContain('deliveryAttempts');
  });

  it('[DEFENCE SEC-010 FIXED] free-text access instructions route through a redacting field resolver', () => {
    expect(onlineOrderFieldResolvers()).toContain('instructions');
  });

  // The authorization itself, exercised against the real service method rather
  // than the source text.
  describe('attemptsFor / instructionsFor authorization', () => {
    const RIDER = 'rider-1';
    const service = Object.create(
      OnlineOrdersService.prototype,
    ) as OnlineOrdersService;

    const order = (status: OrderStatus) =>
      ({
        status,
        customer: { uid: 'cust-1' },
        provider: { providerUid: 'prov-1', branchId: 'branch-1' },
        instructions: {
          accessInstructions: 'Gate code 4471, unit 12B',
          pickupInstructions: 'Ring the bell',
        },
        pickupAttempts: [
          {
            attemptNumber: 1,
            actorUid: RIDER,
            gpsLat: 14.5995,
            gpsLng: 120.9842,
          },
        ],
        pickupAssignment: { assignedStaffUid: RIDER },
        returnAssignment: { assignedStaffUid: RIDER },
      }) as any;

    const courier = { _id: RIDER, role: { roleId: 'courier' } } as any;
    const customer = { _id: 'cust-1', role: { roleId: 'customer' } } as any;
    const owner = { _id: 'prov-1', role: { roleId: 'merchant' } } as any;

    it('[DEFENCE SEC-001 FIXED] a courier OUTSIDE the live leg gets no coordinates', () => {
      const o = order(OrderStatus.COMPLETED);
      const [attempt] = service.attemptsFor(o.pickupAttempts, o, courier);
      expect(attempt.gpsLat).toBeUndefined();
      expect(attempt.gpsLng).toBeUndefined();
      // …but the rest of the evidence record survives, so the history screen
      // still renders.
      expect(attempt.attemptNumber).toBe(1);
    });

    it('[DEFENCE SEC-001 FIXED] a courier INSIDE the live leg keeps the coordinates', () => {
      const o = order(OrderStatus.PICKUP_EN_ROUTE);
      const [attempt] = service.attemptsFor(o.pickupAttempts, o, courier);
      expect(attempt.gpsLat).toBe(14.5995);
    });

    it('[DEFENCE SEC-001 FIXED] customer and provider owner always see the coordinates', () => {
      const o = order(OrderStatus.COMPLETED);
      expect(service.attemptsFor(o.pickupAttempts, o, customer)[0].gpsLat).toBe(
        14.5995,
      );
      expect(service.attemptsFor(o.pickupAttempts, o, owner)[0].gpsLat).toBe(
        14.5995,
      );
    });

    it('[DEFENCE SEC-010 FIXED] access instructions are stripped outside the live leg, operational ones are not', () => {
      const closed = service.instructionsFor(
        order(OrderStatus.COMPLETED),
        courier,
      );
      expect(closed.accessInstructions).toBeUndefined();
      expect(closed.pickupInstructions).toBe('Ring the bell');

      const live = service.instructionsFor(
        order(OrderStatus.PICKUP_EN_ROUTE),
        courier,
      );
      expect(live.accessInstructions).toBe('Gate code 4471, unit 12B');
    });

    it('[DEFENCE SEC-001/SEC-010 FIXED] redaction never mutates the stored document', () => {
      const o = order(OrderStatus.COMPLETED);
      service.attemptsFor(o.pickupAttempts, o, courier);
      service.instructionsFor(o, courier);
      expect(o.pickupAttempts[0].gpsLat).toBe(14.5995);
      expect(o.instructions.accessInstructions).toBe(
        'Gate code 4471, unit 12B',
      );
    });
  });
});

// ===========================================================================
// AUTHZ — missing guards (CONFIRMED FINDING) and error hygiene
// ===========================================================================

describe('SEC / authz / resolver guard coverage', () => {
  it('[DEFENCE SEC-004 FIXED] signupRoles is DELIBERATELY public — sign-up needs a role _id before a token exists', () => {
    // The narrow public replacement for anonymous listRoles. It must stay
    // reachable without a token or customer/partner registration breaks.
    expect(guardsOn(RolesResolver, 'signupRoles')).toHaveLength(0);
    expect(rolesOn(RolesResolver, 'signupRoles')).toBeUndefined();
  });

  it('[DEFENCE SEC-004 FIXED] signupRoles exposes ONLY self-registrable roles — never admin/support/staff/courier', () => {
    // Rows: the public surface is the same constant registration enforces, so
    // it can neither advertise a role registration would reject nor leak a
    // privileged one.
    expect([...SELF_REGISTRABLE_ROLE_IDS].sort()).toEqual([
      'customer',
      'merchant',
      'washer',
    ]);
    for (const forbidden of ['admin', 'support', 'staff', 'courier']) {
      expect(SELF_REGISTRABLE_ROLE_IDS).not.toContain(forbidden);
    }
  });

  it('[DEFENCE SEC-004 FIXED] signupRoles returns the minimal projection and queries only the allowlist', async () => {
    // Columns: no `description`, and no automatic inheritance of fields later
    // added to Role — the exact accident that made listRoles a full dump.
    let capturedFilter: any;
    let capturedProjection: string | undefined;
    const service = Object.create(RolesService.prototype) as RolesService;
    (service as any).roleModel = {
      find: (filter: any) => {
        capturedFilter = filter;
        return {
          select: (p: string) => {
            capturedProjection = p;
            return {
              sort: () => ({
                lean: () => ({
                  exec: () =>
                    Promise.resolve([
                      { _id: 'r1', roleId: 'customer', roleName: 'customer' },
                    ]),
                }),
              }),
            };
          },
        };
      },
    };

    const roles = await service.findSelfRegistrable();
    expect(capturedFilter).toEqual({
      roleId: { $in: SELF_REGISTRABLE_ROLE_IDS },
    });
    expect(capturedProjection).toBe('_id roleId roleName');
    expect(Object.keys(roles[0])).toEqual(['_id', 'roleId', 'roleName']);
    expect(roles[0]).not.toHaveProperty('description');
  });

  it('[DEFENCE SEC-004 FIXED] the SignupRole GraphQL type carries no field beyond the three sign-up needs', () => {
    const src = readFileSync(
      join(__dirname, '../roles/dto/signup-role.output.ts'),
      'utf8',
    );
    const fields = [...src.matchAll(/@Field\([\s\S]*?\)\s*(\w+)!?:/g)].map(
      (m) => m[1],
    );
    expect(fields.sort()).toEqual(['_id', 'roleId', 'roleName']);
    // Check the CODE, not the prose — the doc comment legitimately discusses
    // `description` as the field this type deliberately omits.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/description/);
  });

  it('[DEFENCE SEC-004 FIXED] registration enforces the SAME constant the public query advertises', () => {
    // If these ever diverge, one of two bugs exists: sign-up offers a role that
    // cannot register, or a privileged role becomes self-registrable.
    const usersSrc = readFileSync(
      join(__dirname, '../users/users.service.ts'),
      'utf8',
    );
    expect(usersSrc).toContain(
      'SELF_REGISTRABLE_ROLE_IDS.includes(roleExists.roleId)',
    );
    expect(usersSrc).not.toMatch(/allowedSelfRegistrationRoles\s*=\s*\[/);
  });

  it('[DEFENCE SEC-004 FIXED] listRoles and getRole are guarded and admin-only', () => {
    // Was [FINDING SEC-004]: no guard at all, so an anonymous client could
    // enumerate every role document — a free map of the authorization model.
    for (const q of ['listRoles', 'getRole']) {
      expect(guardsOn(RolesResolver, q).length).toBeGreaterThan(0);
      expect(rolesOn(RolesResolver, q)).toEqual(['admin']);
    }
  });

  it('[DEFENCE] the mutating role operations DO carry guards and are admin-only', () => {
    for (const m of ['createRole', 'updateRole', 'deleteRole']) {
      expect(guardsOn(RolesResolver, m).length).toBeGreaterThan(0);
      expect(rolesOn(RolesResolver, m)).toEqual(['admin']);
    }
  });
});

describe('SEC / authz / error hygiene on REST routes', () => {
  const filter = () =>
    new GlobalExceptionFilter({ warn: jest.fn(), error: jest.fn() } as any);

  const httpHost = () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    return {
      json,
      status,
      host: {
        getType: () => 'http',
        switchToHttp: () => ({
          getResponse: () => ({ status }),
          getRequest: () => ({ method: 'POST', url: '/webhooks/xendit' }),
        }),
      } as any,
    };
  };

  it('[DEFENCE] an unexpected error on a REST route returns a generic 500 — no message, no stack', () => {
    const { host, status, json } = httpHost();
    const secret = new Error('MongoServerError: E11000 dup key on secretIndex');
    filter().catch(secret, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('E11000');
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  it('[DEFENCE] an HttpException on a REST route keeps its own status (no hung request)', () => {
    const { host, status, json } = httpHost();
    filter().catch(new UnauthorizedException('Invalid callback token'), host);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalled();
  });

  const gqlHost = () =>
    ({
      getType: () => 'graphql',
      getArgs: () => [undefined, undefined, {}, undefined],
    }) as any;

  it('[DEFENCE SEC-003 FIXED] an internal error on the GraphQL path is sanitized before Apollo sees it', () => {
    // Was [FINDING SEC-003]: internal (non-HttpException) errors were handed
    // straight back, so their message — and, with Apollo's stacktrace
    // inclusion on, their full stack — reached the client.
    const internal = new Error('Cast to ObjectId failed for value "x"');
    const returned = filter().catch(internal, gqlHost());

    expect(returned).not.toBe(internal);
    expect(returned).toBeInstanceOf(InternalServerErrorException);
    const serialized = JSON.stringify({
      message: returned.message,
      response: returned.getResponse?.(),
    });
    expect(serialized).not.toContain('ObjectId');
    expect(serialized).not.toContain('node_modules');
    expect(returned.stack).not.toContain('Cast to ObjectId');
  });

  it('[DEFENCE SEC-003 FIXED] an expected HttpException still reaches the client intact', () => {
    // Sanitization must not swallow the user-facing errors the FE relies on.
    const expected = new UnauthorizedException('Invalid credentials');
    expect(filter().catch(expected, gqlHost())).toBe(expected);
  });

  it('[DEFENCE SEC-003 FIXED] Apollo stacktrace inclusion is pinned, not left to its NODE_ENV default', () => {
    const appModuleSrc = readFileSync(
      join(__dirname, '../app.module.ts'),
      'utf8',
    );
    expect(appModuleSrc).toMatch(
      /includeStacktraceInErrorResponses:\s*process\.env\.NODE_ENV === 'development'/,
    );
  });
});

// ===========================================================================
// AUTHZ — chat thread order binding (SEC-005)
// ===========================================================================

describe('SEC / authz / chat order binding', () => {
  const ORDER = {
    _id: 'order-1',
    status: OrderStatus.PICKUP_ASSIGNED,
    customer: { uid: 'cust-1' },
    provider: {
      providerUid: 'prov-1',
      branchId: 'branch-1',
      providerType: ProviderType.MERCHANT,
    },
    pickupAssignment: {},
    returnAssignment: {},
  } as any;

  const makeService = (order: any) =>
    new ChatService(
      {
        findOne: () => ({ exec: () => Promise.resolve(null) }),
        create: (doc: any) => Promise.resolve({ _id: 'convo-1', ...doc }),
      } as any,
      { create: jest.fn() } as any,
      {
        findById: () => ({
          exec: () => Promise.resolve({ uid: 'prov-1', branchName: 'Shop' }),
        }),
      } as any,
      { findOne: () => ({ exec: () => Promise.resolve(null) }) } as any,
      { findById: () => ({ exec: () => Promise.resolve(order) }) } as any,
      {} as any,
      {} as any,
    );

  const customer = (id: string) =>
    ({
      _id: id,
      firstName: 'A',
      lastName: 'B',
      role: { roleId: 'customer' },
    }) as any;

  const input = {
    branchId: 'branch-1',
    providerType: ProviderType.MERCHANT,
    orderId: 'order-1',
  } as any;

  it('[DEFENCE SEC-005 FIXED] a customer cannot bind a thread to ANOTHER customer’s order', async () => {
    await expect(
      makeService(ORDER).startConversation(customer('attacker'), input),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[DEFENCE SEC-005 FIXED] a non-existent orderId is rejected, not silently bound', async () => {
    await expect(
      makeService(null).startConversation(customer('cust-1'), input),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('[DEFENCE SEC-005 FIXED] the thread cannot be pointed at a provider that does not hold the order', async () => {
    await expect(
      makeService(ORDER).startConversation(customer('cust-1'), {
        ...input,
        branchId: 'someone-elses-branch',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('[DEFENCE SEC-005 FIXED] the legitimate customer still opens their own thread', async () => {
    await expect(
      makeService(ORDER).startConversation(customer('cust-1'), input),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// MONEY — platform fee on quality-hold surcharges (SEC-007)
// ===========================================================================

describe('SEC / money / quality-hold surcharge fee', () => {
  it('[DEFENCE SEC-007 FIXED] the surcharge is charged the same snapshotted fee rate as the base service', () => {
    // The avoidance path: shift ₱500 of margin out of the service price and
    // into an "approved surcharge". Before the fix platformFeeCentavos was
    // never recomputed, so that ₱500 escaped the 10% fee entirely.
    const feePercent = 10;
    const surchargeCentavos = 50_000;
    expect(calculatePlatformFee(surchargeCentavos, feePercent)).toBe(5_000);
  });

  it('[DEFENCE SEC-007 FIXED] respondToQualityHold recomputes the fee and folds it into the customer total', () => {
    const src = readFileSync(
      join(__dirname, '../online-orders/online-orders.service.ts'),
      'utf8',
    );
    const body = src.slice(
      src.indexOf('async respondToQualityHold('),
      src.indexOf('async autoResolveExpiredQualityHold('),
    );
    expect(body).toContain('calculatePlatformFee(');
    expect(body).toMatch(
      /platformFeeCentavos\s*=[\s\S]{0,120}surchargeFeeCentavos/,
    );
    expect(body).toMatch(
      /customerTotalCentavos\s*=[\s\S]{0,200}surchargeFeeCentavos/,
    );
  });

  it('[DEFENCE SEC-007 FIXED] the surcharge is an integer-centavo field on both the schema and the input', () => {
    const schemaSrc = readFileSync(
      join(__dirname, '../online-orders/schemas/online-order.schema.ts'),
      'utf8',
    );
    expect(schemaSrc).toMatch(
      /@Field\(\(\) => Int, \{ nullable: true \}\) additionalChargeCentavos/,
    );
    const dtoSrc = readFileSync(
      join(__dirname, '../online-orders/dto/quality-hold.input.ts'),
      'utf8',
    );
    expect(dtoSrc).toMatch(/@IsInt\(\)/);
    expect(dtoSrc).toMatch(
      /@Field\(\(\) => Int, \{ nullable: true \}\)\s+additionalChargeCentavos/,
    );
  });
});

// ===========================================================================
// AUTHZ — permission guard bypasses (SEC-009)
// ===========================================================================

describe('SEC / authz / permission guard bypasses', () => {
  const BRANCH_A = '6a11bcb8ffd7d2160b1e0001';
  const BRANCH_B = '6a11bcb8ffd7d2160b1e0002';
  const PERM_ID = '6a11bcb8ffd7d2160b1e00aa';

  const contextFor = (user: any, activeBranchId: string | null = BRANCH_A) =>
    ({
      getHandler: () => 'h',
      getClass: () => 'c',
      getType: () => 'graphql',
      getArgs: () => [
        undefined,
        undefined,
        { req: { user, activeBranchId } },
        undefined,
      ],
    }) as any;

  // The guard reads the catalogue two ways: `find().select().lean()` for the
  // branch-scoped path, `findOne().lean()` for the pre-migration shim.
  const guardWith = (
    required: string[],
    rows: any[] = [],
    matched: any = null,
  ) =>
    new PermissionsGuard(
      { getAllAndOverride: () => required } as any,
      {
        find: () => ({
          select: () => ({
            lean: () => ({ exec: () => Promise.resolve(rows) }),
          }),
        }),
        findOne: () => ({
          lean: () => ({ exec: () => Promise.resolve(matched) }),
          exec: () => Promise.resolve(matched),
        }),
      } as any,
    );

  const userWith = (roleId: string, branchAccess: any[] = []) =>
    ({ _id: 'u1', role: { roleId }, branchAccess }) as any;

  const grantOn = (branchId: string) => [
    { branchId, permissionIds: [PERM_ID] },
  ];

  it('[DEFENCE SEC-009 FIXED] an owner no longer blanket-bypasses an unlisted permission gate', async () => {
    // Was: `if (role?.roleId === 'merchant') return true` — every
    // @RequirePermissions gate in the codebase, present and future, unenforced.
    await expect(
      guardWith(['some_future_permission']).canActivate(
        contextFor(userWith('merchant')),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[DEFENCE SEC-009 FIXED] an owner keeps every catalogued business capability', async () => {
    for (const p of PERMISSION_CATALOGUE.map((s) => s.permissionName)) {
      await expect(
        guardWith([p]).canActivate(contextFor(userWith('merchant'))),
      ).resolves.toBe(true);
    }
  });

  it('[DEFENCE SEC-009 FIXED] an owner needs no active branch — they own every branch', async () => {
    await expect(
      guardWith(['order_create']).canActivate(
        contextFor(userWith('merchant'), null),
      ),
    ).resolves.toBe(true);
  });

  it('[DEFENCE SEC-009 FIXED] the owner floor covers the whole catalogue — drift fails CI, not production', () => {
    for (const seed of PERMISSION_CATALOGUE) {
      expect(OWNER_DEFAULT_PERMISSION_NAMES).toContain(seed.permissionName);
    }
  });

  // ─── Branch-scoped staff grants ──────────────────────────────────────────
  // The implicit staff floor is gone. It used to grant order_confirm_pickup,
  // order_update_status and inventory_edit to every staff account regardless of
  // what the owner had ticked, which made an "off" toggle partly on. Existing
  // staff were given those three explicitly by the backfill migration.

  it('[DEFENCE] the implicit staff floor is gone — an ungranted default is denied', async () => {
    for (const p of STAFF_DEFAULT_PERMISSION_NAMES) {
      await expect(
        guardWith([p], [{ _id: PERM_ID }]).canActivate(
          contextFor(
            userWith('staff', [{ branchId: BRANCH_A, permissionIds: [] }]),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('[DEFENCE] a grant on the active branch authorizes', async () => {
    await expect(
      guardWith(['order_create'], [{ _id: PERM_ID }]).canActivate(
        contextFor(userWith('staff', grantOn(BRANCH_A))),
      ),
    ).resolves.toBe(true);
  });

  it('[DEFENCE] a grant on ANOTHER branch does not authorize here', async () => {
    // The whole point of per-branch permissions: holding Orders in Makati must
    // not let you cancel a BGC order.
    await expect(
      guardWith(['order_create'], [{ _id: PERM_ID }]).canActivate(
        contextFor(userWith('staff', grantOn(BRANCH_B)), BRANCH_A),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[DEFENCE] staff with no active branch are denied, never defaulted to a branch', async () => {
    await expect(
      guardWith(['order_create'], [{ _id: PERM_ID }]).canActivate(
        contextFor(userWith('staff', grantOn(BRANCH_A)), null),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[DEFENCE] explicit grants keep OR semantics across the required list', async () => {
    // A deliberate owner-issued grant of either named permission passes; that
    // was true before branch scoping and stays true.
    await expect(
      guardWith(
        ['order_create', 'order_confirm_pickup'],
        [{ _id: PERM_ID }],
      ).canActivate(contextFor(userWith('staff', grantOn(BRANCH_A)))),
    ).resolves.toBe(true);
  });

  it('[DEFENCE] a role with no per-branch grants never passes a gated resolver', async () => {
    for (const roleId of [
      'washer',
      'courier',
      'customer',
      'admin',
      'support',
    ]) {
      await expect(
        guardWith(['order_create'], [{ _id: PERM_ID }]).canActivate(
          contextFor(userWith(roleId, grantOn(BRANCH_A))),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('[ROLLOUT] a pre-migration staff document falls back to the account-global union', async () => {
    // Cached user docs outlive the deploy. One written before the backfill has
    // no branchAccess at all; denying it would sign out every staff member for
    // the cache TTL. Delete this shim, and the test, one release on.
    const legacy = {
      _id: 'u1',
      role: { roleId: 'staff' },
      permissionIds: ['p1'],
    };
    await expect(
      guardWith(['order_create'], [], {
        permissionName: 'order_create',
      }).canActivate(contextFor(legacy as any, null)),
    ).resolves.toBe(true);
  });

  it('[ROLLOUT] an EMPTY branchAccess is a grant of nothing, not a legacy document', async () => {
    await expect(
      guardWith(['order_create'], [{ _id: PERM_ID }], {
        permissionName: 'order_create',
      }).canActivate(contextFor(userWith('staff', []))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('[DEFENCE] an unauthenticated caller never satisfies a permission gate', async () => {
    await expect(
      guardWith(['order_create']).canActivate(contextFor(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ===========================================================================
// MONEY — webhook rate limiting and payload shape (SEC-012 / SEC-014)
// ===========================================================================

describe('SEC / money / webhook hardening', () => {
  it('[DEFENCE SEC-012 FIXED] the webhook has its own throttle bucket, not the shared 100/min', () => {
    // Reading decorator metadata off the method reference — never called here,
    // so the unbound-method concern does not apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = XenditWebhookController.prototype.handleInvoiceCallback;
    // @Throttle writes `<KEY><name>` metadata for the named bucket it overrides.
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(
      XENDIT_WEBHOOK_THROTTLE.limit,
    );
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
      XENDIT_WEBHOOK_THROTTLE.ttl,
    );
    // …and that bucket is materially larger than the shared 100/min budget the
    // rest of the app uses, so retry storms cannot 429 themselves into more
    // retries or starve interactive traffic.
    expect(XENDIT_WEBHOOK_THROTTLE.limit).toBeGreaterThan(100);
  });

  it('[DEFENCE SEC-014 FIXED] the callback body is a validated DTO class, not an erased interface', async () => {
    // An `interface` is erased at compile time, so ValidationPipe had no
    // metadata and validated nothing.
    const operatorInjection = plainToInstance(XenditInvoiceCallbackDto, {
      external_id: { $ne: null },
      status: 'PAID',
      amount: 1000,
    });
    const errors = await validate(operatorInjection);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.property)).toContain('external_id');
  });

  it('[DEFENCE SEC-014 FIXED] a well-formed callback body validates cleanly', async () => {
    const ok = plainToInstance(XenditInvoiceCallbackDto, {
      id: 'inv_9',
      external_id: 'intent-42',
      status: 'PAID',
      amount: 250.5,
      currency: 'PHP',
    });
    expect(await validate(ok)).toHaveLength(0);
  });

  it('[DEFENCE SEC-014 FIXED] the handler itself rejects a non-string external_id even without the pipe', async () => {
    const controller = new XenditWebhookController(
      {
        postVerifiedTopUp: jest.fn(),
        resolveIntentWithoutCredit: jest.fn(),
      } as any,
      configWith({ XENDIT_CALLBACK_TOKEN: 'secret' }),
    );
    await expect(
      controller.handleInvoiceCallback('secret', {
        external_id: { $ne: null },
        status: 'PAID',
        amount: 1000,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
