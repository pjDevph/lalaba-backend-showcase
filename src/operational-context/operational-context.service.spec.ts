import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';

import { OperationalContextService } from './operational-context.service';
import {
  ContextModuleKey,
  ContextSubjectType,
} from './models/operational-context.model';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { Branch } from '../branches/schemas/branch.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { WasherProfile } from '../washer/schemas/washer-profile.schema';
import { KycDocument } from '../kyc/schemas/kyc-document.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { SupportTicket } from '../support-tickets/schemas/support-ticket.schema';

/**
 * RISK-BO-001. The danger in assembling several records behind one address is
 * that the address becomes a way to read something the caller could not read
 * on its own page — so these tests are mostly about what does NOT come back,
 * and about the queries that are never issued in the first place.
 */
type Chain = Record<string, jest.Mock>;

function chainModel(rows: unknown[] = [], one: unknown = null): Chain {
  const chain: Chain = {};
  const self = () => chain;
  chain.find = jest.fn(self);
  chain.findById = jest.fn(() => ({
    populate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(one) })),
    exec: jest.fn().mockResolvedValue(one),
  }));
  chain.findOne = jest.fn(self);
  chain.populate = jest.fn(self);
  chain.select = jest.fn(self);
  chain.sort = jest.fn(self);
  chain.limit = jest.fn(self);
  chain.countDocuments = jest.fn(() => ({
    exec: jest.fn().mockResolvedValue(rows.length),
  }));
  chain.aggregate = jest.fn(() => ({
    exec: jest.fn().mockResolvedValue([]),
  }));
  chain.exec = jest.fn().mockResolvedValue(rows);
  return chain;
}

const MERCHANT = {
  _id: 'uid-merchant',
  firstName: 'Test',
  lastName: 'Merchant',
  email: 'merchant@example.com',
  phoneNumber: '09123564812',
  isActive: true,
  role: { roleId: 'merchant' },
};

describe('OperationalContextService', () => {
  let service: OperationalContextService;
  let models: Record<string, Chain>;

  async function build(subject: unknown = MERCHANT) {
    models = {
      user: chainModel([], subject),
      role: chainModel(),
      branch: chainModel([
        { _id: 'branch-1', branchName: 'Branch A', isActive: true },
      ]),
      wallet: chainModel([], {
        branchId: 'branch-1',
        balanceCentavos: 150000,
        activatedAt: new Date(),
      }),
      washer: chainModel([], null),
      kyc: chainModel([]),
      order: chainModel([]),
      ticket: chainModel([]),
    };
    // findOne returns a chainable whose exec resolves the "one" document.
    models.wallet.findOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({
        branchId: 'branch-1',
        balanceCentavos: 150000,
        activatedAt: new Date(),
      }),
    }));
    models.washer.findOne = jest.fn(() => ({
      select: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(null) })),
    }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        OperationalContextService,
        { provide: getModelToken(User.name), useValue: models.user },
        { provide: getModelToken(Role.name), useValue: models.role },
        { provide: getModelToken(Branch.name), useValue: models.branch },
        { provide: getModelToken(Wallet.name), useValue: models.wallet },
        { provide: getModelToken(WasherProfile.name), useValue: models.washer },
        { provide: getModelToken(KycDocument.name), useValue: models.kyc },
        { provide: getModelToken(OnlineOrder.name), useValue: models.order },
        { provide: getModelToken(SupportTicket.name), useValue: models.ticket },
      ],
    }).compile();

    service = moduleRef.get(OperationalContextService);
  }

  it('[HP] assembles the wallet for an admin', async () => {
    await build();
    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-merchant',
      'admin',
    );
    expect(context.modules).toContain(ContextModuleKey.WALLET);
    expect(context.wallet?.balanceCentavos).toBe(150000);
  });

  it('[SEC] withholds the wallet from support, and never queries it', async () => {
    // The one real asymmetry in the matrix: WalletsAdminResolver is
    // class-level @Roles('admin'), which is also why the panel does not grant
    // wallet:read to support. Assembling a context must not route around it.
    await build();
    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-merchant',
      'support',
    );

    expect(context.wallet).toBeUndefined();
    expect(context.modules).not.toContain(ContextModuleKey.WALLET);
    // Not fetched-then-stripped: fetching would leak existence through timing
    // and costs the query anyway.
    expect(models.wallet.findOne).not.toHaveBeenCalled();
  });

  it('[SEC] gives support everything else on the same subject', async () => {
    await build();
    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-merchant',
      'support',
    );
    expect(context.modules).toEqual(
      expect.arrayContaining([
        ContextModuleKey.IDENTITY,
        ContextModuleKey.ORDERS,
        ContextModuleKey.TICKETS,
      ]),
    );
  });

  it('[SEC] a role outside the matrix gets identity and nothing else', async () => {
    // The resolver guard rejects a merchant first; this asserts the service is
    // not a second way in if that guard ever loosens.
    await build();
    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-merchant',
      'merchant',
    );
    expect(context.modules).toEqual([ContextModuleKey.IDENTITY]);
    expect(context.orders).toBeUndefined();
    expect(context.tickets).toBeUndefined();
    expect(context.wallet).toBeUndefined();
  });

  it('[EC] offers no branches or staff for a customer', async () => {
    // A customer is not a provider. Modules must be absent because they do not
    // APPLY, which the payload reports the same way as "not permitted" — the
    // reason `modules` exists for the UI to read.
    await build({
      _id: 'uid-customer',
      firstName: 'PJ',
      lastName: 'Tester',
      isActive: true,
      role: { roleId: 'customer' },
    });

    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-customer',
      'admin',
    );

    expect(context.modules).not.toContain(ContextModuleKey.BRANCHES);
    expect(context.modules).not.toContain(ContextModuleKey.STAFF);
    expect(context.modules).not.toContain(ContextModuleKey.KYC);
  });

  it('[EC] gives a home washer no staff module', async () => {
    // She has an anchor branch so the shared inventory FK chain works, not a
    // business with employees. Offering a staff list would invent a structure
    // that does not exist for her.
    await build({
      _id: 'uid-washer',
      firstName: 'Ana',
      lastName: 'Cruz',
      isActive: true,
      role: { roleId: 'washer' },
    });

    const context = await service.build(
      ContextSubjectType.PERSON,
      'uid-washer',
      'admin',
    );

    expect(context.modules).not.toContain(ContextModuleKey.STAFF);
  });

  it('[EC] refuses an unknown subject rather than returning an empty shell', async () => {
    await build(null);
    await expect(
      service.build(ContextSubjectType.PERSON, 'nobody', 'admin'),
    ).rejects.toThrow('Account not found');
  });

  describe('maySee', () => {
    it('[SEC] pins the module matrix so a widening is a deliberate edit', () => {
      expect(
        OperationalContextService.maySee(ContextModuleKey.WALLET, 'admin'),
      ).toBe(true);
      expect(
        OperationalContextService.maySee(ContextModuleKey.WALLET, 'support'),
      ).toBe(false);
      expect(
        OperationalContextService.maySee(ContextModuleKey.ORDERS, 'support'),
      ).toBe(true);
      expect(
        OperationalContextService.maySee(ContextModuleKey.KYC, 'support'),
      ).toBe(true);
      for (const role of [
        'customer',
        'merchant',
        'washer',
        'staff',
        'courier',
      ]) {
        expect(
          OperationalContextService.maySee(ContextModuleKey.ORDERS, role),
        ).toBe(false);
      }
    });
  });
});
