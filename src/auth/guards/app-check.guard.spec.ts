import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GraphQLError } from 'graphql';
import { AppCheckGuard, APP_CHECK_HEADER } from './app-check.guard';
import { REQUIRE_APP_CHECK } from '../decorators/require-app-check.decorator';
import { BiometricResolver } from '../../biometric/biometric.resolver';

/**
 * B3 — TEST-APPCHK-002/003/005/006/007/008/009/010.
 *
 * 001, 004, 011 and 012 need a real device or the Firebase console and are
 * tracked as manual evidence in PROD-READINESS.md; nothing here pretends to
 * cover them.
 */

const verifyToken = jest.fn();

const makeGuard = (opts: { required?: boolean; enforced?: boolean }) => {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(opts.required ?? true),
  } as unknown as Reflector;

  const firebase = {
    getAppCheck: () => ({ verifyToken }),
  };

  const config = {
    get: jest.fn().mockReturnValue(opts.enforced ? 'on' : 'off'),
  } as unknown as ConfigService;

  return new AppCheckGuard(reflector, firebase as never, config);
};

const contextWith = (headers: Record<string, unknown> = {}) =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    getType: () => 'graphql',
    getArgs: () => [undefined, undefined, { req: { headers } }, undefined],
  }) as unknown as ExecutionContext;

const withToken = (token: string) => contextWith({ [APP_CHECK_HEADER]: token });

beforeEach(() => {
  verifyToken.mockReset();
  verifyToken.mockResolvedValue({ appId: '1:123:android:abc' });
});

// ---------------------------------------------------------------------------

describe('TEST-APPCHK-002 — missing token on a protected operation', () => {
  it('EC: rejected when enforcement is on', async () => {
    const guard = makeGuard({ enforced: true });
    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(
      GraphQLError,
    );
  });

  it('EC: the rejection carries APP_CHECK_REQUIRED for the client to act on', async () => {
    const guard = makeGuard({ enforced: true });
    await guard.canActivate(contextWith({})).catch((e: GraphQLError) => {
      expect(e.extensions.code).toBe('APP_CHECK_REQUIRED');
    });
    expect.assertions(1);
  });

  it('EC: an empty or whitespace header counts as missing', async () => {
    const guard = makeGuard({ enforced: true });
    for (const value of ['', '   ']) {
      await expect(guard.canActivate(withToken(value))).rejects.toThrow(
        GraphQLError,
      );
    }
  });

  it('EC: a non-string header value counts as missing', async () => {
    const guard = makeGuard({ enforced: true });
    await expect(
      guard.canActivate(contextWith({ [APP_CHECK_HEADER]: ['a', 'b'] })),
    ).rejects.toThrow(GraphQLError);
  });
});

describe('TEST-APPCHK-003 — invalid token', () => {
  it('EC: a token the verifier rejects is refused', async () => {
    verifyToken.mockRejectedValue(new Error('Decoding App Check token failed'));
    const guard = makeGuard({ enforced: true });

    await expect(guard.canActivate(withToken('garbage'))).rejects.toThrow(
      GraphQLError,
    );
  });

  it('EC: an expired token is refused', async () => {
    verifyToken.mockRejectedValue(new Error('token has expired'));
    const guard = makeGuard({ enforced: true });
    await expect(guard.canActivate(withToken('expired'))).rejects.toThrow(
      GraphQLError,
    );
  });

  it('EC: the verifier’s own message is NOT echoed to the caller', async () => {
    // "expired" vs "malformed" vs "wrong project" is free reconnaissance for
    // anyone probing. The detail belongs in the server log only.
    verifyToken.mockRejectedValue(
      new Error('App Check token belongs to project 999'),
    );
    const guard = makeGuard({ enforced: true });

    await guard.canActivate(withToken('x')).catch((e: GraphQLError) => {
      expect(e.message).not.toContain('999');
      expect(e.message).not.toContain('project');
      expect(e.extensions.code).toBe('APP_CHECK_INVALID');
    });
    expect.assertions(3);
  });

  it('HP: a valid token passes', async () => {
    const guard = makeGuard({ enforced: true });
    await expect(guard.canActivate(withToken('good'))).resolves.toBe(true);
    expect(verifyToken).toHaveBeenCalledWith('good');
  });
});

describe('TEST-APPCHK-005 — App Check is independent of user auth', () => {
  it('EC: a valid Firebase ID token does not substitute for App Check', async () => {
    // APPCHK-014: the two answer different questions. A session says WHO; App
    // Check says WHETHER THIS IS OUR APP. A stolen ID token replayed from a
    // script has the first and not the second.
    const guard = makeGuard({ enforced: true });
    await expect(
      guard.canActivate(
        contextWith({ authorization: 'Bearer a-perfectly-valid-id-token' }),
      ),
    ).rejects.toThrow(GraphQLError);
  });

  it('HP: App Check does not itself authenticate anyone', async () => {
    // Passing this guard yields `true` and nothing else — no user is attached,
    // so GqlAuthGuard remains the only thing that can establish identity.
    const guard = makeGuard({ enforced: true });
    const ctx = withToken('good');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    const req = ctx.getArgs()[2].req;
    expect(req.user).toBeUndefined();
  });
});

describe('TEST-APPCHK-006/007 — the biometric operations are the protected set', () => {
  const reflector = new Reflector();

  // The two method references below are METADATA LOOKUP KEYS, not calls —
  // reflector.get() reads the decorator off them and never invokes them, so
  // there is no `this` to lose. unbound-method cannot distinguish that from a
  // method about to be called detached, so it is silenced per line, with the
  // reason, rather than the assertions being contorted around a false
  // positive. `.bind()` here would defeat the lookup: it returns a new
  // function object carrying none of the original's metadata.

  it('HP: requestBiometricChallenge carries @RequireAppCheck', () => {
    expect(
      reflector.get(
        REQUIRE_APP_CHECK,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        BiometricResolver.prototype.requestBiometricChallenge,
      ),
    ).toBe(true);
  });

  it('HP: biometricLogin carries @RequireAppCheck', () => {
    expect(
      reflector.get(
        REQUIRE_APP_CHECK,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        BiometricResolver.prototype.biometricLogin,
      ),
    ).toBe(true);
  });

  it('EC: both are refused without a token under enforcement', async () => {
    const guard = makeGuard({ enforced: true });
    await expect(guard.canActivate(contextWith({}))).rejects.toThrow(
      /could not be verified/,
    );
  });
});

describe('TEST-APPCHK-010 — clients without App Check keep working before enforcement', () => {
  it('HP: monitoring mode allows a request with no token', async () => {
    // The Admin Panel uses Firebase Auth and calls the same /graphql endpoint
    // with no App Check provider wired. Blocking it here would take out
    // provider suspension, wallet adjustment and KYC decisions.
    const guard = makeGuard({ enforced: false });
    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
  });

  it('HP: monitoring mode allows a request whose token is INVALID', async () => {
    verifyToken.mockRejectedValue(new Error('bad token'));
    const guard = makeGuard({ enforced: false });
    await expect(guard.canActivate(withToken('bad'))).resolves.toBe(true);
  });

  it('HP: monitoring mode still VERIFIES a present token', async () => {
    // The evidence that enforcement is safe to enable has to be collected
    // before it is enabled, not after.
    const guard = makeGuard({ enforced: false });
    await guard.canActivate(withToken('good'));
    expect(verifyToken).toHaveBeenCalledWith('good');
  });

  it('HP: an unmarked handler is untouched in either mode', async () => {
    for (const enforced of [true, false]) {
      const guard = makeGuard({ required: false, enforced });
      await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
    }
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe('TEST-APPCHK-008/009 — enforcement is config-gated, not guessable', () => {
  it('EC: no value other than "on" enables enforcement', async () => {
    // Same convention as MONGODB_ONLINE / ADMIN_MFA_REQUIRED: case-insensitive
    // 'on', and nothing else. A typo means monitoring, never a half-enabled
    // state that rejects some clients and not others.
    for (const value of ['true', '1', 'yes', 'enabled', 'off', '']) {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(true),
      } as unknown as Reflector;
      const config = {
        get: jest.fn().mockReturnValue(value),
      } as unknown as ConfigService;
      const guard = new AppCheckGuard(
        reflector,
        { getAppCheck: () => ({ verifyToken }) } as never,
        config,
      );
      // Anything but 'on' means monitoring, so a missing token is allowed.
      await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
    }
  });

  it('HP: "on" with surrounding whitespace and case still enforces', async () => {
    for (const value of ['  on  ', 'On', 'ON ']) {
      const reflector = {
        getAllAndOverride: jest.fn().mockReturnValue(true),
      } as unknown as Reflector;
      const config = {
        get: jest.fn().mockReturnValue(value),
      } as unknown as ConfigService;
      const guard = new AppCheckGuard(
        reflector,
        { getAppCheck: () => ({ verifyToken }) } as never,
        config,
      );
      await expect(guard.canActivate(contextWith({}))).rejects.toThrow(
        GraphQLError,
      );
    }
  });
});
