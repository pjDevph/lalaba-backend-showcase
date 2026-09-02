import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { DirectoryService } from './directory.service';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import {
  OnlineOrder,
  OnlineOrderSchema,
} from '../online-orders/schemas/online-order.schema';
import {
  SupportTicket,
  SupportTicketSchema,
} from '../support-tickets/schemas/support-ticket.schema';
import { Wallet, WalletSchema } from '../wallets/schemas/wallet.schema';
import { Device, DeviceSchema } from '../devices/schemas/device.schema';
import {
  WasherProfile,
  WasherProfileSchema,
} from '../washer/schemas/washer-profile.schema';
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { FirebaseService } from '../firebase/firebase.service';
import {
  ProviderType,
  OrderStatus,
  FulfillmentPickupMode,
  FulfillmentReturnMode,
} from '../online-orders/schemas/order-status.enum';
import {
  TicketCategory,
  TicketSource,
  TicketStatus,
  TicketPriority,
} from '../support-tickets/schemas/support-ticket.schema';

describe('DirectoryService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: DirectoryService;

  const createCustomToken = jest.fn(
    async (uid: string) => `fake-token-for-${uid}`,
  );
  const firebaseService = {
    getAuth: () => ({ createCustomToken }),
  };

  const makeRole = async (roleId: string) =>
    (await connection.models[Role.name].findOne({ roleId }).exec()) ??
    (await connection.models[Role.name].create({
      roleId,
      roleName: roleId,
      description: `${roleId} role`,
    }));

  const makeUser = async (
    firstName: string,
    roleId: string,
    overrides: { phoneNumber?: string; isActive?: boolean } = {},
  ) => {
    const role = await makeRole(roleId);
    const uid = new Types.ObjectId().toString();
    await connection.models[User.name].create({
      _id: uid,
      firstName,
      lastName: 'Test',
      email: `${uid}@example.com`,
      phoneNumber: overrides.phoneNumber ?? `0917${uid.slice(-7)}`,
      role: role._id,
      isActive: overrides.isActive ?? true,
    });
    return uid;
  };

  const makeOrder = async (opts: { customerUid?: string; branchId?: string }) =>
    connection.models[OnlineOrder.name].create({
      customer: {
        uid: opts.customerUid ?? new Types.ObjectId().toString(),
        displayName: 'Someone',
      },
      provider: {
        providerType: ProviderType.MERCHANT,
        providerUid: new Types.ObjectId().toString(),
        branchId: opts.branchId ?? new Types.ObjectId().toString(),
        providerName: 'Shop',
      },
      serviceLines: [],
      fulfillment: {
        pickupMode: FulfillmentPickupMode.PROVIDER_PICKUP,
        returnMode: FulfillmentReturnMode.PROVIDER_DELIVERY,
      },
      pricing: { customerTotalCentavos: 0 },
      paymentSummary: {},
      status: OrderStatus.COMPLETED,
    });

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
          { name: OnlineOrder.name, schema: OnlineOrderSchema },
          { name: SupportTicket.name, schema: SupportTicketSchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: Device.name, schema: DeviceSchema },
          { name: WasherProfile.name, schema: WasherProfileSchema },
          { name: Branch.name, schema: BranchSchema },
        ]),
      ],
      providers: [
        DirectoryService,
        { provide: FirebaseService, useValue: firebaseService },
      ],
    }).compile();

    service = module.get(DirectoryService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      User.name,
      Role.name,
      OnlineOrder.name,
      SupportTicket.name,
      Wallet.name,
      Device.name,
      WasherProfile.name,
      Branch.name,
    ]) {
      await connection.models[name].deleteMany({});
    }
    createCustomToken.mockClear();
  });

  describe('list', () => {
    it('returns every role, not just back-office accounts', async () => {
      await makeUser('Cara', 'customer');
      await makeUser('Wendy', 'washer');
      await makeUser('Mario', 'merchant');

      const page = await service.list();

      expect(page.total).toBe(3);
      expect(page.data.map((u) => u.roleId).sort()).toEqual([
        'customer',
        'merchant',
        'washer',
      ]);
    });

    it('finds an account by name, email, or exact uid', async () => {
      const uid = await makeUser('Bernadette', 'customer');
      await makeUser('Juan', 'customer');

      expect((await service.list({ search: 'bernad' })).total).toBe(1);
      expect((await service.list({ search: uid })).total).toBe(1);
      expect((await service.list({ search: `${uid}@example.com` })).total).toBe(
        1,
      );
    });

    // Same normalisation as the order search, so support can paste the same
    // string into either box.
    it('finds an account by phone however it was typed', async () => {
      await makeUser('Cara', 'customer', { phoneNumber: '09171234567' });
      await makeUser('Other', 'customer', { phoneNumber: '09990000000' });

      for (const term of ['09171234567', '+639171234567', '0917 123 4567']) {
        expect((await service.list({ search: term })).total).toBe(1);
      }
    });

    it('treats regex metacharacters in a search as literals', async () => {
      await makeUser('Cara', 'customer');
      expect((await service.list({ search: '.*' })).total).toBe(0);
    });

    it('filters by role and by active state', async () => {
      await makeUser('Cara', 'customer');
      await makeUser('Wendy', 'washer');
      await makeUser('Gone', 'customer', { isActive: false });

      expect((await service.list({ roleIds: ['customer'] })).total).toBe(2);
      expect((await service.list({ isActive: false })).total).toBe(1);
      expect(
        (await service.list({ roleIds: ['customer'], isActive: true })).total,
      ).toBe(1);
    });

    // Dropping an unmatched clause would silently widen the query to every
    // account on the platform — the opposite of what was asked for.
    it('returns nothing for a role that does not exist', async () => {
      await makeUser('Cara', 'customer');

      expect((await service.list({ roleIds: ['not-a-role'] })).total).toBe(0);
    });

    it('counts other accounts sharing a phone number, excluding itself', async () => {
      await makeUser('Twin A', 'customer', { phoneNumber: '09171112222' });
      await makeUser('Twin B', 'washer', { phoneNumber: '09171112222' });
      await makeUser('Alone', 'customer', { phoneNumber: '09173334444' });

      const page = await service.list();
      const byName = new Map(page.data.map((u) => [u.displayName, u]));

      expect(byName.get('Twin A Test')!.sharedPhoneCount).toBe(1);
      expect(byName.get('Twin B Test')!.sharedPhoneCount).toBe(1);
      // An account always shares its number with itself; reporting 1 here
      // would make the column meaningless.
      expect(byName.get('Alone Test')!.sharedPhoneCount).toBe(0);
    });

    it('reports a total for the whole match, not the page', async () => {
      for (let i = 0; i < 5; i++) await makeUser(`User${i}`, 'customer');

      const page = await service.list({ limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });

  describe('detail', () => {
    it('throws for an account that does not exist', async () => {
      await expect(service.detail('nobody')).rejects.toThrow(NotFoundException);
    });

    it('counts the orders an account placed', async () => {
      const uid = await makeUser('Cara', 'customer');
      await makeOrder({ customerUid: uid });
      await makeOrder({ customerUid: uid });
      await makeOrder({});

      const detail = await service.detail(uid);

      expect(detail.ordersAsCustomer).toBe(2);
      expect(detail.ordersAsProvider).toBe(0);
      expect(detail.lastOrderAt).toBeInstanceOf(Date);
    });

    it('counts the orders a washer fulfilled, through her anchor branch', async () => {
      const uid = await makeUser('Wendy', 'washer');
      const branchId = new Types.ObjectId().toString();
      await connection.models[WasherProfile.name].create({
        uid,
        branchId,
        displayName: 'Wendy',
        storeName: "Wendy's Laundry",
      });
      await makeOrder({ branchId });
      await makeOrder({ branchId });

      const detail = await service.detail(uid);

      expect(detail.ordersAsProvider).toBe(2);
      expect(detail.ordersAsCustomer).toBe(0);
    });

    // Null and zero mean different things: no wallet at all, versus a
    // provider who has run out of money.
    it('reports no wallet as null rather than a zero balance', async () => {
      const customerUid = await makeUser('Cara', 'customer');
      const washerUid = await makeUser('Wendy', 'washer');
      const branchId = new Types.ObjectId().toString();
      await connection.models[WasherProfile.name].create({
        uid: washerUid,
        branchId,
        displayName: 'Wendy',
        storeName: "Wendy's Laundry",
      });
      await connection.models[Wallet.name].create({
        branchId,
        balanceCentavos: 0,
      });

      expect(
        (await service.detail(customerUid)).walletBalanceCentavos,
      ).toBeUndefined();
      expect((await service.detail(washerUid)).walletBalanceCentavos).toBe(0);
    });

    it('lists other accounts sharing the phone number', async () => {
      const uid = await makeUser('Twin A', 'customer', {
        phoneNumber: '09171112222',
      });
      await makeUser('Twin B', 'washer', { phoneNumber: '09171112222' });
      await makeUser('Unrelated', 'customer', { phoneNumber: '09179998888' });

      const detail = await service.detail(uid);

      expect(detail.linkedAccounts).toHaveLength(1);
      expect(detail.linkedAccounts[0]).toMatchObject({
        displayName: 'Twin B Test',
        roleId: 'washer',
        matchedOn: 'PHONE',
      });
    });

    // The account being viewed must never appear in its own linked list.
    it('excludes the account itself from its linked accounts', async () => {
      const uid = await makeUser('Solo', 'customer', {
        phoneNumber: '09170000000',
      });

      expect((await service.detail(uid)).linkedAccounts).toEqual([]);
    });

    it('counts tickets the account raised', async () => {
      const uid = await makeUser('Cara', 'customer');
      await connection.models[SupportTicket.name].create({
        ticketNumber: 'LAL-000001',
        subject: 's',
        body: 'b',
        source: TicketSource.CUSTOMER_APP,
        category: TicketCategory.OTHER,
        status: TicketStatus.OPEN,
        priority: TicketPriority.NORMAL,
        requester: { uid, displayName: 'Cara', role: 'customer' },
      });

      expect((await service.detail(uid)).ticketsRaised).toBe(1);
    });

    it('lists devices registered by or for the account', async () => {
      const uid = await makeUser('Mario', 'merchant');
      await connection.models[Device.name].create({
        uid,
        deviceName: 'Counter iPad',
        operatingSystem: 'iPadOS',
        fcmToken: 'token-1',
      });

      const detail = await service.detail(uid);

      expect(detail.devices).toHaveLength(1);
      expect(detail.devices[0].deviceName).toBe('Counter iPad');
    });

    it('surfaces whether sessions have ever been force-ended', async () => {
      const uid = await makeUser('Cara', 'customer');
      expect((await service.detail(uid)).sessionsValidAfter).toBeUndefined();

      const when = new Date();
      await connection.models[User.name].updateOne(
        { _id: uid },
        { $set: { sessionsValidAfter: when } },
      );

      expect((await service.detail(uid)).sessionsValidAfter).toEqual(when);
    });
  });

  describe('impersonate', () => {
    it('mints a token via Firebase for the target uid', async () => {
      const admin = await makeUser('Ada', 'admin');
      const customer = await makeUser('Cara', 'customer');

      const token = await service.impersonate(customer, admin);

      expect(createCustomToken).toHaveBeenCalledWith(
        customer,
        expect.objectContaining({ impersonation: true, actorUid: admin }),
      );
      expect(token.customToken).toBe(`fake-token-for-${customer}`);
      expect(token.targetUid).toBe(customer);
      expect(token.targetRoleId).toBe('customer');
      expect(token.targetName).toBe('Cara Test');
    });

    // The one privilege-escalation path this whole panel exists to prevent: a
    // single compromised admin session must not be a way to mint credentials
    // for every OTHER admin on the platform.
    it.each(['admin', 'support'])(
      'refuses to impersonate a %s account',
      async (roleId) => {
        const admin = await makeUser('Ada', 'admin');
        const target = await makeUser('Target', roleId);

        await expect(service.impersonate(target, admin)).rejects.toThrow(
          ForbiddenException,
        );
        expect(createCustomToken).not.toHaveBeenCalled();
      },
    );

    // A token minted for a deactivated account would fail on the very first
    // request the client made with it — GqlAuthGuard checks isActive before
    // anything else. Refusing here catches that before a dead token is ever
    // handed out.
    it('refuses to impersonate a deactivated account', async () => {
      const admin = await makeUser('Ada', 'admin');
      const target = await makeUser('Gone', 'customer', { isActive: false });

      await expect(service.impersonate(target, admin)).rejects.toThrow(
        BadRequestException,
      );
      expect(createCustomToken).not.toHaveBeenCalled();
    });

    it('allows impersonating every non-back-office role', async () => {
      const admin = await makeUser('Ada', 'admin');
      for (const roleId of [
        'customer',
        'washer',
        'merchant',
        'staff',
        'courier',
      ]) {
        const target = await makeUser(`T-${roleId}`, roleId);
        await expect(service.impersonate(target, admin)).resolves.toBeDefined();
      }
    });

    it('refuses to impersonate yourself', async () => {
      const admin = await makeUser('Ada', 'admin');

      await expect(service.impersonate(admin, admin)).rejects.toThrow(
        BadRequestException,
      );
      expect(createCustomToken).not.toHaveBeenCalled();
    });

    it('throws for a target that does not exist', async () => {
      const admin = await makeUser('Ada', 'admin');

      await expect(
        service.impersonate(new Types.ObjectId().toString(), admin),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
