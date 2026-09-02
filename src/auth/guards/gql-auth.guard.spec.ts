import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlAuthGuard } from './gql-auth.guard';
import { ALLOW_UNVERIFIED_COURIER } from '../decorators/allow-unverified-courier.decorator';
import { ALLOW_UNREGISTERED_DEVICE } from '../decorators/allow-unregistered-device.decorator';

// The courier liveness gate lives in GqlAuthGuard, so it is the thing that
// actually enforces "no order handling before a selfie". The client gate is UX;
// this is the one that has to hold. Constructed directly rather than through a
// TestingModule — the rest of the guard's dependency chain (Firebase) is
// irrelevant to this branch and expensive to stand up.
describe('GqlAuthGuard — courier liveness gate', () => {
  const handler = function testHandler() {};
  const cls = class TestResolver {};

  // getArgs must return a STABLE reference — GqlExecutionContext reads the
  // request out of args[2], so a fresh array per call loses the auth header and
  // every test would fail on authentication instead of reaching the gate.
  const makeContext = (): ExecutionContext => {
    const args = [
      {},
      {},
      { req: { headers: { authorization: 'Bearer fake-token' } } },
      {},
    ];
    return {
      getArgs: () => args,
      getClass: () => cls,
      getHandler: () => handler,
      getType: () => 'graphql',
    } as unknown as ExecutionContext;
  };

  const buildGuard = (
    user: Record<string, unknown>,
    metadata: Record<string, boolean> = {},
    opts: {
      tokenIssuedAtMs?: number;
      usedSecondFactor?: boolean;
      mfaRequired?: boolean;
    } = {},
  ) => {
    const firebaseService = {
      getAuth: () => ({ verifyIdToken: jest.fn() }),
    };
    const usersService = {
      findOneByIdWithRoleCached: jest.fn(async () => user),
    };
    const devicesService = {
      resolveDeviceAuth: jest.fn(async () => ({
        authorized: true,
        branchId: 'branch-a',
        staffUid: String(user._id),
      })),
    };
    const maintenanceService = {
      effectiveStateForRole: jest.fn(async () => ({
        blocked: false,
        type: null,
        message: null,
        endsAt: null,
      })),
    };
    const reflector = {
      getAllAndOverride: jest.fn(
        (key: string) => metadata[key] ?? false,
      ) as unknown,
    } as Reflector;
    // The token resolves straight from cache so verifyIdToken is never
    // reached. Object shape, matching the v2 cache entry the guard writes.
    const cache = {
      get: jest.fn(async () => ({
        uid: String(user._id),
        issuedAtMs: opts.tokenIssuedAtMs ?? Date.now(),
        usedSecondFactor: opts.usedSecondFactor ?? false,
      })),
      set: jest.fn(async () => undefined),
    };
    const config = {
      get: jest.fn(() => (opts.mfaRequired ? 'on' : undefined)),
    };

    return new GqlAuthGuard(
      firebaseService as never,
      usersService as never,
      devicesService as never,
      maintenanceService as never,
      reflector,
      config as never,
      cache as never,
    );
  };

  const courier = (selfieStatus: string | null) => ({
    _id: 'courier-uid',
    isActive: true,
    role: { roleId: 'courier' },
    selfieStatus,
  });

  const run = async (
    user: Record<string, unknown>,
    metadata: Record<string, boolean> = {},
  ) => buildGuard(user, metadata).canActivate(makeContext());

  // Asserting the MESSAGE, not just the exception type: every failure path in
  // this guard throws UnauthorizedException, so a bare type assertion would
  // pass just as happily on an unrelated auth failure and prove nothing.
  it('[SEC] blocks a courier who has never submitted a selfie', async () => {
    await expect(run(courier(null))).rejects.toThrow(
      /Take your verification selfie/,
    );
  });

  it('[SEC] blocks a courier whose selfie was revoked', async () => {
    await expect(run(courier('REVOKED'))).rejects.toThrow(
      /removed by an administrator/,
    );
  });

  it('[SEC] blocks a courier whose selfie was superseded but never re-activated', async () => {
    await expect(run(courier('SUPERSEDED'))).rejects.toThrow(
      /Take your verification selfie/,
    );
  });

  it('[HP] allows a courier with a live selfie', async () => {
    await expect(run(courier('ACTIVE'))).resolves.toBe(true);
  });

  it('[HP] allows an unverified courier through the bootstrap path', async () => {
    // Without this escape hatch a courier could never reach the mutation that
    // opens their own gate, and every courier would be locked out permanently.
    await expect(
      run(courier(null), { [ALLOW_UNVERIFIED_COURIER]: true }),
    ).resolves.toBe(true);
  });

  it('[SEC] the gate does not apply to other roles', async () => {
    // A merchant has no selfieStatus at all; the gate must not read as "unset
    // means blocked" for everyone.
    await expect(
      run({
        _id: 'merchant-uid',
        isActive: true,
        role: { roleId: 'merchant' },
      }),
    ).resolves.toBe(true);
  });

  it('[SEC] a staff user is still gated on device, not on selfie', async () => {
    // Guards against the courier branch accidentally swallowing the staff path.
    await expect(
      run(
        {
          _id: 'staff-uid',
          isActive: true,
          merchantId: 'merchant-uid',
          role: { roleId: 'staff' },
        },
        { [ALLOW_UNREGISTERED_DEVICE]: true },
      ),
    ).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('GqlAuthGuard — session revocation', () => {
  const handler = function testHandler() {};
  const cls = class TestResolver {};

  const makeContext = (): ExecutionContext => {
    const args = [
      {},
      {},
      { req: { headers: { authorization: 'Bearer fake-token' } } },
      {},
    ];
    return {
      getArgs: () => args,
      getClass: () => cls,
      getHandler: () => handler,
      getType: () => 'graphql',
    } as unknown as ExecutionContext;
  };

  const build = (
    user: Record<string, unknown>,
    opts: {
      tokenIssuedAtMs?: number;
      usedSecondFactor?: boolean;
      mfaRequired?: boolean;
    } = {},
  ) =>
    new GqlAuthGuard(
      { getAuth: () => ({ verifyIdToken: jest.fn() }) } as never,
      { findOneByIdWithRoleCached: jest.fn(async () => user) } as never,
      {
        resolveDeviceAuth: jest.fn(async () => ({
          authorized: true,
          branchId: 'branch-a',
          staffUid: null,
        })),
      } as never,
      {
        effectiveStateForRole: jest.fn(async () => ({
          blocked: false,
          type: null,
          message: null,
          endsAt: null,
        })),
      } as never,
      { getAllAndOverride: jest.fn(() => false) } as unknown as Reflector,
      { get: jest.fn(() => (opts.mfaRequired ? 'on' : undefined)) } as never,
      {
        get: jest.fn(async () => ({
          uid: String(user._id),
          issuedAtMs: opts.tokenIssuedAtMs ?? Date.now(),
          usedSecondFactor: opts.usedSecondFactor ?? false,
        })),
        set: jest.fn(async () => undefined),
      } as never,
    );

  const admin = (extra: Record<string, unknown> = {}) => ({
    _id: 'admin-uid',
    isActive: true,
    role: { roleId: 'admin' },
    ...extra,
  });

  const HOUR = 60 * 60 * 1000;

  it('[SEC] rejects a token issued before the revocation instant', async () => {
    // The whole point of force-logout: the access token already in the
    // caller's hands must stop working immediately, not in an hour.
    const guard = build(admin({ sessionsValidAfter: new Date() }), {
      tokenIssuedAtMs: Date.now() - HOUR,
    });

    await expect(guard.canActivate(makeContext())).rejects.toMatchObject({
      // The client keys off this code, not the message.
      extensions: { code: 'SESSION_REVOKED' },
    });
  });

  it('[HP] allows a token issued after the revocation instant', async () => {
    // Logging back in has to work, or revocation is a permanent ban.
    const guard = build(
      admin({ sessionsValidAfter: new Date(Date.now() - HOUR) }),
      { tokenIssuedAtMs: Date.now() },
    );

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  it('[HP] ignores accounts that have never been revoked', async () => {
    const guard = build(admin(), { tokenIssuedAtMs: 0 });

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('GqlAuthGuard — back-office MFA gate', () => {
  const handler = function testHandler() {};
  const cls = class TestResolver {};

  const makeContext = (): ExecutionContext => {
    const args = [
      {},
      {},
      { req: { headers: { authorization: 'Bearer fake-token' } } },
      {},
    ];
    return {
      getArgs: () => args,
      getClass: () => cls,
      getHandler: () => handler,
      getType: () => 'graphql',
    } as unknown as ExecutionContext;
  };

  const build = (
    user: Record<string, unknown>,
    opts: { usedSecondFactor?: boolean; mfaRequired?: boolean } = {},
  ) =>
    new GqlAuthGuard(
      { getAuth: () => ({ verifyIdToken: jest.fn() }) } as never,
      { findOneByIdWithRoleCached: jest.fn(async () => user) } as never,
      {
        resolveDeviceAuth: jest.fn(async () => ({
          authorized: true,
          branchId: 'branch-a',
          staffUid: null,
        })),
      } as never,
      {
        effectiveStateForRole: jest.fn(async () => ({
          blocked: false,
          type: null,
          message: null,
          endsAt: null,
        })),
      } as never,
      { getAllAndOverride: jest.fn(() => false) } as unknown as Reflector,
      { get: jest.fn(() => (opts.mfaRequired ? 'on' : undefined)) } as never,
      {
        get: jest.fn(async () => ({
          uid: String(user._id),
          issuedAtMs: Date.now(),
          usedSecondFactor: opts.usedSecondFactor ?? false,
        })),
        set: jest.fn(async () => undefined),
      } as never,
    );

  const withRole = (roleId: string) => ({
    _id: `${roleId}-uid`,
    isActive: true,
    role: { roleId },
  });

  // Default OFF is deliberate: switching enforcement on rejects every admin
  // who has not enrolled, including whoever would log in to turn it back off.
  it('[HP] is off unless ADMIN_MFA_REQUIRED is exactly "on"', async () => {
    const guard = build(withRole('admin'), { usedSecondFactor: false });

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  it('[SEC] blocks an admin without a second factor once enabled', async () => {
    const guard = build(withRole('admin'), {
      mfaRequired: true,
      usedSecondFactor: false,
    });

    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      /Two-factor authentication is required/i,
    );
  });

  it('[SEC] blocks support too, not just admin', async () => {
    const guard = build(withRole('support'), {
      mfaRequired: true,
      usedSecondFactor: false,
    });

    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      /Two-factor authentication is required/i,
    );
  });

  it('[HP] admits an admin who used a second factor', async () => {
    const guard = build(withRole('admin'), {
      mfaRequired: true,
      usedSecondFactor: true,
    });

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });

  // Customers and providers sign in from phones and are not the threat model.
  // Applying this to them would lock the entire userbase out of the product.
  it('[SEC] never applies to non-back-office roles', async () => {
    for (const roleId of ['customer', 'merchant', 'washer']) {
      const guard = build(withRole(roleId), {
        mfaRequired: true,
        usedSecondFactor: false,
      });
      await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Staff device gate — the device now selects which branch's grants apply
// ═══════════════════════════════════════════════════════════════════════════

describe('GqlAuthGuard — staff device gate', () => {
  const cls = class {};
  const handler = () => undefined;

  const STAFF_UID = 'staff-uid-1';
  const staff = {
    _id: STAFF_UID,
    isActive: true,
    merchantId: 'merchant-uid-1',
    role: { roleId: 'staff' },
  };

  const makeReq = () => ({
    headers: {
      authorization: 'Bearer fake-token',
      'x-device-token': 'device-token-1',
    },
  });

  const build = (
    deviceAuth: {
      authorized: boolean;
      branchId: string | null;
      staffUid: string | null;
    },
    metadata: Record<string, boolean> = {},
  ) =>
    new GqlAuthGuard(
      { getAuth: () => ({ verifyIdToken: jest.fn() }) } as never,
      { findOneByIdWithRoleCached: jest.fn(async () => staff) } as never,
      { resolveDeviceAuth: jest.fn(async () => deviceAuth) } as never,
      {
        effectiveStateForRole: jest.fn(async () => ({
          blocked: false,
          type: null,
          message: null,
          endsAt: null,
        })),
      } as never,
      {
        getAllAndOverride: jest.fn((key: string) => metadata[key] ?? false),
      } as never,
      { get: jest.fn(() => undefined) } as never,
      {
        get: jest.fn(async () => ({
          uid: STAFF_UID,
          issuedAtMs: Date.now(),
          usedSecondFactor: false,
        })),
        set: jest.fn(async () => undefined),
      } as never,
    );

  const runWith = async (
    deviceAuth: {
      authorized: boolean;
      branchId: string | null;
      staffUid: string | null;
    },
    metadata: Record<string, boolean> = {},
  ) => {
    const req = makeReq();
    const ctx = {
      getArgs: () => [{}, {}, { req }, {}],
      getClass: () => cls,
      getHandler: () => handler,
      getType: () => 'graphql',
    } as unknown as ExecutionContext;
    const result = await build(deviceAuth, metadata).canActivate(ctx);
    return { result, req: req as Record<string, unknown> };
  };

  it("[HP] carries the device's branch onto the request", async () => {
    const { result, req } = await runWith({
      authorized: true,
      branchId: 'branch-a',
      staffUid: STAFF_UID,
    });
    expect(result).toBe(true);
    // PermissionsGuard reads this to pick which grants apply.
    expect(req.activeBranchId).toBe('branch-a');
  });

  it("[SEC] rejects another staff member's device token", async () => {
    // The device was only ever matched on (owner, token). Harmless-ish when it
    // merely decided entry; a privilege selector now that it picks the branch.
    await expect(
      runWith({
        authorized: true,
        branchId: 'branch-a',
        staffUid: 'someone-else',
      }),
    ).rejects.toThrow(/registered to another account/);
  });

  it('[SEC] rejects an approved device with no branch rather than guessing one', async () => {
    await expect(
      runWith({ authorized: true, branchId: null, staffUid: STAFF_UID }),
    ).rejects.toThrow(/not assigned to a branch/);
  });

  it('[COMPAT] lets a legacy device with no staffUid through', async () => {
    // Rows predating the field carry null and are admitted on the same grounds
    // they always were.
    const { result } = await runWith({
      authorized: true,
      branchId: 'branch-a',
      staffUid: null,
    });
    expect(result).toBe(true);
  });

  it('[SEC] still rejects an unapproved device', async () => {
    await expect(
      runWith({ authorized: false, branchId: null, staffUid: STAFF_UID }),
    ).rejects.toThrow(/not registered or has been deactivated/);
  });

  it('[HP] the bootstrap path skips the gate and leaves no active branch', async () => {
    // registerDevice/myDevice must be reachable BEFORE approval, or a staff
    // member could never open their own gate.
    const { result, req } = await runWith(
      { authorized: false, branchId: null, staffUid: STAFF_UID },
      { [ALLOW_UNREGISTERED_DEVICE]: true },
    );
    expect(result).toBe(true);
    expect(req.activeBranchId).toBeNull();
  });
});
