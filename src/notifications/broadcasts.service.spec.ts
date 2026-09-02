import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';

import { BroadcastsService } from './broadcasts.service';
import {
  NotificationsService,
  FCM_MULTICAST_LIMIT,
} from './notifications.service';
import {
  Broadcast,
  BroadcastSchema,
  BroadcastStatus,
} from './schemas/broadcast.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';

/**
 * A broadcast cannot be recalled, so these tests are mostly about the things
 * that decide WHO receives one, and about the record left behind when it goes
 * wrong.
 */
describe('BroadcastsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: BroadcastsService;

  /** Records what it was asked to send; returns whatever `dead` is set to. */
  const notifications = {
    sendToTokens: jest.fn<Promise<string[]>, [string[], unknown]>(),
  };

  const admin = {
    _id: 'admin-uid',
    firstName: 'Ada',
    lastName: 'Reyes',
    email: 'ada@lalaba.ph',
  } as unknown as User;

  const makeRole = async (roleId: string) =>
    (await connection.models[Role.name].findOne({ roleId }).exec()) ??
    (await connection.models[Role.name].create({
      roleId,
      roleName: roleId,
      description: `${roleId} role`,
    }));

  const makeUser = async (
    roleId: string,
    opts: { tokens?: string[]; isActive?: boolean } = {},
  ) => {
    const role = await makeRole(roleId);
    const uid = new Types.ObjectId().toString();
    await connection.models[User.name].create({
      _id: uid,
      firstName: 'Test',
      lastName: 'Person',
      email: `${uid}@example.com`,
      phoneNumber: '09171234567',
      role: role._id,
      isActive: opts.isActive ?? true,
      fcmTokens: opts.tokens ?? [],
    });
    return uid;
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: Broadcast.name, schema: BroadcastSchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
        ]),
      ],
      providers: [
        BroadcastsService,
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(BroadcastsService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [Broadcast.name, User.name, Role.name]) {
      await connection.models[name].deleteMany({});
    }
    notifications.sendToTokens.mockReset();
    notifications.sendToTokens.mockResolvedValue([]);
  });

  const send = (
    audienceRoleIds: string[],
    extra: { includeInactive?: boolean } = {},
  ) =>
    service.send(
      {
        title: 'Scheduled maintenance',
        body: 'Lalaba will be briefly unavailable tonight.',
        audienceRoleIds,
        includeInactive: extra.includeInactive,
      },
      admin,
    );

  describe('audience resolution', () => {
    it('sends only to the selected roles', async () => {
      await makeUser('customer', { tokens: ['tok-customer'] });
      await makeUser('washer', { tokens: ['tok-washer'] });

      await send(['customer']);

      expect(notifications.sendToTokens).toHaveBeenCalledTimes(1);
      expect(notifications.sendToTokens.mock.calls[0][0]).toEqual([
        'tok-customer',
      ]);
    });

    it('reaches several roles at once', async () => {
      await makeUser('customer', { tokens: ['a'] });
      await makeUser('washer', { tokens: ['b'] });

      await send(['customer', 'washer']);

      expect(notifications.sendToTokens.mock.calls[0][0].sort()).toEqual([
        'a',
        'b',
      ]);
    });

    // The worst possible failure mode: an unrecognised role silently widening
    // the send to every account on the platform.
    it('sends to nobody when the role does not exist', async () => {
      await makeUser('customer', { tokens: ['tok'] });

      const broadcast = await send(['not-a-role']);

      expect(notifications.sendToTokens).not.toHaveBeenCalled();
      expect(broadcast.status).toBe(BroadcastStatus.NO_RECIPIENTS);
      expect(broadcast.audienceCount).toBe(0);
    });

    it('refuses an empty audience rather than treating it as everyone', async () => {
      await expect(send([])).rejects.toThrow(BadRequestException);
    });

    // A deactivated account should not be marketed to.
    it('excludes deactivated accounts unless asked', async () => {
      await makeUser('customer', { tokens: ['live'] });
      await makeUser('customer', { tokens: ['gone'], isActive: false });

      await send(['customer']);
      expect(notifications.sendToTokens.mock.calls[0][0]).toEqual(['live']);

      notifications.sendToTokens.mockClear();
      await send(['customer'], { includeInactive: true });
      expect(notifications.sendToTokens.mock.calls[0][0].sort()).toEqual([
        'gone',
        'live',
      ]);
    });

    // The same device can land on two accounts after a shared-phone signup;
    // two notifications for one message reads as a bug to whoever holds it.
    it('de-duplicates a token shared by two accounts', async () => {
      await makeUser('customer', { tokens: ['shared'] });
      await makeUser('washer', { tokens: ['shared'] });

      await send(['customer', 'washer']);

      expect(notifications.sendToTokens.mock.calls[0][0]).toEqual(['shared']);
    });
  });

  describe('preview', () => {
    // These three numbers are usually very different, and the difference is
    // the point — an admin should see it before choosing their words.
    it('separates the audience from who can actually be reached', async () => {
      await makeUser('customer', { tokens: ['a', 'b'] });
      await makeUser('customer', { tokens: [] }); // never opened the app
      await makeUser('customer', { tokens: ['c'] });

      const preview = await service.preview(['customer']);

      expect(preview.audienceCount).toBe(3);
      expect(preview.reachableCount).toBe(2);
      expect(preview.tokenCount).toBe(3);
    });

    it('sends nothing', async () => {
      await makeUser('customer', { tokens: ['a'] });

      await service.preview(['customer']);

      expect(notifications.sendToTokens).not.toHaveBeenCalled();
    });
  });

  describe('the record', () => {
    it('records what was sent, to how many, and by whom', async () => {
      await makeUser('customer', { tokens: ['a', 'b'] });
      await makeUser('customer', { tokens: ['c'] });

      const broadcast = await send(['customer']);

      expect(broadcast).toMatchObject({
        title: 'Scheduled maintenance',
        status: BroadcastStatus.SENT,
        audienceCount: 2,
        tokenCount: 3,
        sentByUid: 'admin-uid',
        sentByName: 'Ada Reyes',
      });
    });

    // A send that reached nobody must not read as a success, or someone will
    // fire the same message four times wondering why nothing arrived.
    it('distinguishes "nobody was reachable" from "sent"', async () => {
      await makeUser('customer', { tokens: [] });

      const broadcast = await send(['customer']);

      expect(broadcast.status).toBe(BroadcastStatus.NO_RECIPIENTS);
      expect(broadcast.audienceCount).toBe(1);
      expect(broadcast.tokenCount).toBe(0);
    });

    // The row is written before the send, so a crash mid-way still leaves
    // evidence that an attempt was made.
    it('records a failure instead of losing the attempt', async () => {
      await makeUser('customer', { tokens: ['a'] });
      notifications.sendToTokens.mockRejectedValueOnce(
        new Error('credentials rejected'),
      );

      const broadcast = await send(['customer']);

      expect(broadcast.status).toBe(BroadcastStatus.FAILED);
      expect(broadcast.failureReason).toContain('credentials rejected');
      expect((await service.history()).total).toBe(1);
    });

    it('prunes tokens FCM rejected, so the next preview stays honest', async () => {
      const uid = await makeUser('customer', { tokens: ['live', 'dead'] });
      notifications.sendToTokens.mockResolvedValueOnce(['dead']);

      const broadcast = await send(['customer']);

      expect(broadcast.deadTokenCount).toBe(1);
      const preview = await service.preview(['customer']);
      expect(preview.tokenCount).toBe(1);
      const user = await connection.models[User.name].findById(uid).exec();
      expect((user as unknown as { fcmTokens: string[] }).fcmTokens).toEqual([
        'live',
      ]);
    });

    it('lists history newest first', async () => {
      await makeUser('customer', { tokens: ['a'] });
      await service.send(
        { title: 'First', body: 'b', audienceRoleIds: ['customer'] },
        admin,
      );
      await service.send(
        { title: 'Second', body: 'b', audienceRoleIds: ['customer'] },
        admin,
      );

      const { data, total } = await service.history();

      expect(total).toBe(2);
      expect(data[0].title).toBe('Second');
    });
  });

  it('exposes the FCM multicast limit the chunking relies on', () => {
    // Pinned because broadcasts are the only caller that can exceed it, and a
    // silent change would fail only in production with a large audience.
    expect(FCM_MULTICAST_LIMIT).toBe(500);
  });
});
