import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PosOrdersResolver } from '../../pos_orders/pos-orders.resolver';
import { InventoryResolver } from '../../inventory/inventory.resolver';
import { ProductsResolver } from '../../products/products.resolver';
import { ServicesResolver } from '../../services/services.resolver';
import { TasksResolver } from '../../tasks/tasks.resolver';

/**
 * SEC-031/032 — merchant-side resolvers must refuse non-merchant roles.
 *
 * The metadata block reads @Roles off the REAL resolver classes rather than a
 * fixture, so it fails if someone removes the decorator. That matters more
 * than usual here: RolesGuard returns true when no metadata is present, so a
 * deleted @Roles line fails open and nothing else would notice.
 */

const MERCHANT_SIDE = [
  ['PosOrdersResolver', PosOrdersResolver],
  ['InventoryResolver', InventoryResolver],
  ['ProductsResolver', ProductsResolver],
  ['ServicesResolver', ServicesResolver],
  ['TasksResolver', TasksResolver],
] as const;

describe('merchant-side resolvers carry a role floor', () => {
  const reflector = new Reflector();

  it.each(MERCHANT_SIDE)('HP: %s is gated to merchant + staff', (_n, cls) => {
    expect(reflector.get<string[]>(ROLES_KEY, cls)).toEqual([
      'merchant',
      'staff',
    ]);
  });

  it.each(MERCHANT_SIDE)(
    'EC: %s admits neither customer nor courier',
    (_n, cls) => {
      const roles = reflector.get<string[]>(ROLES_KEY, cls) ?? [];
      expect(roles).not.toContain('customer');
      expect(roles).not.toContain('courier');
      expect(roles).not.toContain('washer');
    },
  );
});

describe('RolesGuard enforcement', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (roleId: string | null, required?: string[]) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      getType: () => 'graphql',
      getArgs: () => [
        undefined,
        undefined,
        { req: { user: roleId ? { role: { roleId } } : undefined } },
        undefined,
      ],
      // Reflector reads through these; stub the lookup directly instead.
      __required: required,
    }) as unknown as ExecutionContext;

  // Reflector.getAllAndOverride hits reflect-metadata on the stubs above, so
  // drive the requirement explicitly.
  const run = (roleId: string | null, required: string[] | undefined) => {
    jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockReturnValue(required);
    return () => guard.canActivate(contextFor(roleId));
  };

  afterEach(() => jest.restoreAllMocks());

  it('EC: a customer is refused a merchant-only operation (SEC-031)', () => {
    expect(run('customer', ['merchant', 'staff'])).toThrow(ForbiddenException);
  });

  it('EC: a courier is refused a merchant-only operation (SEC-032)', () => {
    expect(run('courier', ['merchant', 'staff'])).toThrow(ForbiddenException);
  });

  it('EC: a washer is refused a merchant-only operation', () => {
    expect(run('washer', ['merchant', 'staff'])).toThrow(ForbiddenException);
  });

  it('HP: a merchant passes', () => {
    expect(run('merchant', ['merchant', 'staff'])()).toBe(true);
  });

  it('HP: staff pass', () => {
    expect(run('staff', ['merchant', 'staff'])()).toBe(true);
  });

  it('EC: a request with no user at all is refused', () => {
    expect(run(null, ['merchant', 'staff'])).toThrow(ForbiddenException);
  });

  it('EC: absent metadata still fails OPEN — the documented gap (SEC-033)', () => {
    // Pinned deliberately, not endorsed. This is why a missing @Roles is
    // invisible, and it is the decision SEC-033 exists to revisit. If that
    // default is ever inverted, this test is the one that should fail first.
    expect(run('customer', undefined)()).toBe(true);
  });
});
