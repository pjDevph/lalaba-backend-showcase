import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';

import { SearchService } from './search.service';
import { SearchEntityType } from './models/search-result.model';
import { MatchStrength, MatchedOn } from './term.util';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { Branch } from '../branches/schemas/branch.schema';
import { OnlineOrder } from '../online-orders/schemas/online-order.schema';
import { SupportTicket } from '../support-tickets/schemas/support-ticket.schema';

/**
 * The behaviour worth pinning here is the authorization boundary and the
 * ranking — not Mongo. The models are stubbed to the smallest chainable shape
 * the service actually uses.
 */
type Chain = {
  find: jest.Mock;
  populate: jest.Mock;
  select: jest.Mock;
  sort: jest.Mock;
  limit: jest.Mock;
  exec: jest.Mock;
  aggregate: jest.Mock;
};

function chainModel(rows: unknown[] = []): Chain {
  const chain: Partial<Chain> = {};
  const self = () => chain as Chain;
  chain.find = jest.fn(self);
  chain.populate = jest.fn(self);
  chain.select = jest.fn(self);
  chain.sort = jest.fn(self);
  chain.limit = jest.fn(self);
  chain.exec = jest.fn().mockResolvedValue(rows);
  chain.aggregate = jest.fn(() => ({ exec: jest.fn().mockResolvedValue([]) }));
  return chain as Chain;
}

describe('SearchService', () => {
  let service: SearchService;
  let users: Chain;
  let branches: Chain;
  let orders: Chain;
  let tickets: Chain;

  async function build(models: {
    users?: unknown[];
    branches?: unknown[];
    orders?: unknown[];
    tickets?: unknown[];
  }) {
    users = chainModel(models.users ?? []);
    branches = chainModel(models.branches ?? []);
    orders = chainModel(models.orders ?? []);
    tickets = chainModel(models.tickets ?? []);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getModelToken(User.name), useValue: users },
        { provide: getModelToken(Role.name), useValue: chainModel() },
        { provide: getModelToken(Branch.name), useValue: branches },
        { provide: getModelToken(OnlineOrder.name), useValue: orders },
        { provide: getModelToken(SupportTicket.name), useValue: tickets },
      ],
    }).compile();

    service = moduleRef.get(SearchService);
  }

  it('[HP] finds a customer by an exact phone number', async () => {
    await build({
      users: [
        {
          _id: 'uid-1',
          firstName: 'Maria',
          lastName: 'Santos',
          phoneNumber: '+639171234567',
          email: 'maria@example.com',
          isActive: true,
          role: { roleId: 'customer' },
        },
      ],
    });

    const { results } = await service.search('09171234567', 'support');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      entityType: SearchEntityType.CUSTOMER,
      id: 'uid-1',
      title: 'Maria Santos',
      matchedOn: MatchedOn.PHONE,
      matchStrength: MatchStrength.EXACT,
    });
  });

  it('[HP] reports the role as the entity type', async () => {
    await build({
      users: [
        {
          _id: 'uid-2',
          firstName: 'Ana',
          lastName: 'Cruz',
          phoneNumber: '+639170000000',
          isActive: true,
          role: { roleId: 'washer' },
        },
      ],
    });

    const { results } = await service.search('Ana Cruz', 'admin');
    expect(results[0].entityType).toBe(SearchEntityType.PROVIDER);
  });

  it('[EC] returns nothing for a term too short to mean anything', async () => {
    await build({ users: [{ _id: 'x' }] });
    const { results, searchedTypes } = await service.search('ab', 'admin');
    expect(results).toEqual([]);
    expect(searchedTypes).toEqual([]);
    // The point is that it did not go to the database at all.
    expect(users.find).not.toHaveBeenCalled();
  });

  it('[SEC] never searches a type the caller has no role for', async () => {
    await build({ users: [], orders: [], tickets: [], branches: [] });

    const { searchedTypes } = await service.search('maria', 'merchant');

    // A merchant is not a back-office role. The resolver's own guard rejects
    // them first; this asserts the service is not a second way in if that
    // guard ever loosens.
    expect(searchedTypes).toEqual([]);
    expect(users.find).not.toHaveBeenCalled();
    expect(orders.find).not.toHaveBeenCalled();
    expect(tickets.find).not.toHaveBeenCalled();
    expect(branches.find).not.toHaveBeenCalled();
  });

  it('[SEC] reports which types it searched, so "not searched" is not read as "not found"', async () => {
    await build({});
    const { searchedTypes } = await service.search('maria', 'support');
    expect(searchedTypes).toEqual(
      expect.arrayContaining([
        SearchEntityType.CUSTOMER,
        SearchEntityType.ORDER,
        SearchEntityType.TICKET,
        SearchEntityType.BRANCH,
      ]),
    );
  });

  it('[HP] ranks an exact order-number hit above a name hit', async () => {
    await build({
      users: [
        {
          _id: 'uid-3',
          firstName: 'LB',
          lastName: 'Laundry',
          isActive: true,
          role: { roleId: 'customer' },
        },
      ],
      orders: [
        {
          _id: 'order-1',
          orderNumber: 'LB-000123',
          status: 'completed',
          customer: { displayName: 'Maria Santos' },
          provider: { providerName: 'Kapehingahan' },
        },
      ],
    });

    const { results } = await service.search('LB-000123', 'admin');

    expect(results[0].entityType).toBe(SearchEntityType.ORDER);
    expect(results[0].matchedOn).toBe(MatchedOn.ORDER_NUMBER);
  });

  it('[REG] finds a person by their FULL name, not just one field', async () => {
    // Caught by the first end-to-end run: "PJ Tester" returned the order —
    // whose snapshot stores one displayName — and not the person, because no
    // single field on a user record holds a whole name. Typing someone's full
    // name is the most natural thing an operator does.
    await build({ users: [] });

    await service.search('Maria Santos', 'admin');

    const clauses = (users.find.mock.calls[0][0] as { $or: unknown[] }).$or;
    const combined = clauses.find(
      (c) => typeof c === 'object' && c !== null && '$and' in c,
    ) as { $and: [{ firstName: unknown }, { lastName: unknown }] } | undefined;

    // Jest's expect takes one argument — the failure message goes in the
    // test name, not here.
    expect(combined).toBeDefined();
    expect(JSON.stringify(combined)).toContain('Maria');
    expect(JSON.stringify(combined)).toContain('Santos');
  });

  it('[REG] never reports a back-office account as a customer', async () => {
    // Also from the first end-to-end run: an unmapped role fell through to
    // CUSTOMER, so searching an admin's email returned the platform
    // administrator typed as a customer.
    await build({
      users: [
        {
          _id: 'uid-admin',
          firstName: 'Prince',
          lastName: 'Gandollas',
          email: 'admin@lalaba.test',
          isActive: true,
          role: { roleId: 'admin' },
        },
      ],
    });

    const { results } = await service.search('admin@lalaba.test', 'admin');
    expect(results[0].entityType).toBe(SearchEntityType.BACK_OFFICE);
  });

  it('[HP] puts the person before their order when both match equally', async () => {
    // Both are NAME/EXACT for "PJ Tester", so rank alone cannot separate them.
    // The operator searched a person; the order is what they open next, FROM
    // the person — which is also the shape the operational context takes.
    await build({
      users: [
        {
          _id: 'uid-5',
          firstName: 'PJ',
          lastName: 'Tester',
          isActive: true,
          role: { roleId: 'customer' },
        },
      ],
      orders: [
        {
          _id: 'order-2',
          orderNumber: 'LB-000001',
          status: 'completed',
          customer: { displayName: 'PJ Tester' },
          provider: { providerName: 'WashWash Angono' },
        },
      ],
    });

    const { results } = await service.search('PJ Tester', 'admin');

    expect(results[0].entityType).toBe(SearchEntityType.CUSTOMER);
    expect(results[1].entityType).toBe(SearchEntityType.ORDER);
  });

  it('[EC] survives one searcher failing rather than losing the whole box', async () => {
    await build({
      users: [
        {
          _id: 'uid-4',
          firstName: 'Maria',
          lastName: 'Santos',
          isActive: true,
          role: { roleId: 'customer' },
        },
      ],
    });
    orders.exec.mockRejectedValue(new Error('orders unavailable'));

    const { results } = await service.search('Maria', 'admin');

    // Four of five kinds is a useful answer; an error is not.
    expect(
      results.some((r) => r.entityType === SearchEntityType.CUSTOMER),
    ).toBe(true);
  });
});
