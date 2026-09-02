import { BadRequestException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection } from 'mongoose';

import { MaintenanceApp, MaintenanceService } from './maintenance.service';
import {
  MaintenanceConfig,
  MaintenanceConfigSchema,
  MaintenanceType,
} from './schemas/maintenance-config.schema';
import { UpdateMaintenanceConfigInput } from './dto/maintenance.input';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';

/**
 * GAP-MNT-001 and the reachability invariant.
 *
 * The anonymous cold-start path and the "a block always leaves people
 * somewhere to turn" rule are both things nobody notices are broken until an
 * outage, which is the worst possible time to find out.
 */
describe('MaintenanceService', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: MaintenanceService;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: MaintenanceConfig.name, schema: MaintenanceConfigSchema },
        ]),
      ],
      providers: [
        MaintenanceService,
        // A no-op cache: this suite is about the rules, and a 15s TTL would
        // make every test depend on the order of the one before it.
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: () => undefined,
            set: () => undefined,
            del: () => undefined,
          },
        },
      ],
    }).compile();

    service = module.get(MaintenanceService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await connection.models[MaintenanceConfig.name].deleteMany({});
  });

  const app = (
    over: Partial<UpdateMaintenanceConfigInput['customerApp']> = {},
  ) => ({
    active: false,
    mode: MaintenanceType.EMERGENCY,
    message: null,
    scheduledStart: null,
    scheduledEnd: null,
    ...over,
  });

  const input = (
    over: Partial<UpdateMaintenanceConfigInput> = {},
  ): UpdateMaintenanceConfigInput => ({
    globalEmergencyActive: false,
    globalEmergencyMessage: null,
    customerApp: app(),
    partnerApp: app(),
    supportEmail: 'support@lalaba.ph',
    supportPhone: null,
    bypassUids: [],
    ...over,
  });

  /** A User-shaped object with a populated role, as the guard supplies it. */
  const actor = (roleId: string, uid = 'uid-1') =>
    ({ _id: uid, role: { roleId } }) as unknown as User & { role: Role };

  // ── The reachability invariant (TEST-MNT-011 / TEST-MNT-012) ────────────

  describe('a block must always leave people somewhere to turn', () => {
    it('refuses to switch a block on with no support contact', async () => {
      await expect(
        service.update(
          input({
            customerApp: app({ active: true, message: 'Back soon.' }),
            supportEmail: null,
            supportPhone: null,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to CLEAR the contacts while a block is already active', async () => {
      // The hole a transition-only rule leaves open: block first with a
      // contact, then delete the contact in a second, innocent-looking save.
      await service.update(
        input({ customerApp: app({ active: true, message: 'Back soon.' }) }),
      );

      await expect(
        service.update(
          input({
            customerApp: app({ active: true, message: 'Back soon.' }),
            supportEmail: null,
            supportPhone: null,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses the same for the global override', async () => {
      await expect(
        service.update(
          input({
            globalEmergencyActive: true,
            globalEmergencyMessage: 'Down.',
            supportEmail: null,
            supportPhone: null,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a phone number alone', async () => {
      const saved = await service.update(
        input({
          customerApp: app({ active: true, message: 'Back soon.' }),
          supportEmail: null,
          supportPhone: '+63 900 000 0000',
        }),
      );
      expect(saved.customerApp.active).toBe(true);
    });

    it('allows no contact at all when nothing is blocked', async () => {
      const saved = await service.update(
        input({ supportEmail: null, supportPhone: null }),
      );
      expect(saved.supportEmail).toBeNull();
    });

    it('does not persist a refused write', async () => {
      await service.update(
        input({ customerApp: app({ active: true, message: 'First.' }) }),
      );
      await expect(
        service.update(
          input({
            customerApp: app({ active: true, message: 'Second.' }),
            supportEmail: null,
            supportPhone: null,
          }),
        ),
      ).rejects.toThrow();

      const still = await service.current();
      expect(still.customerApp.message).toBe('First.');
      expect(still.supportEmail).toBe('support@lalaba.ph');
    });
  });

  // ── The anonymous cold-start answer (GAP-MNT-001) ───────────────────────

  describe('publicStateForApp', () => {
    it('reports a blocked customer app to a caller with no session (TEST-MNT-001)', async () => {
      await service.update(
        input({
          customerApp: app({ active: true, message: 'Under maintenance.' }),
          supportEmail: 'help@lalaba.ph',
          supportPhone: '+63 900 000 0000',
        }),
      );

      const status = await service.publicStateForApp(MaintenanceApp.CUSTOMER);
      expect(status.blocked).toBe(true);
      expect(status.type).toBe(MaintenanceType.EMERGENCY);
      expect(status.message).toBe('Under maintenance.');
      expect(status.supportEmail).toBe('help@lalaba.ph');
      expect(status.supportPhone).toBe('+63 900 000 0000');
    });

    it('reports a blocked partner app (TEST-MNT-002)', async () => {
      await service.update(
        input({ partnerApp: app({ active: true, message: 'Partners down.' }) }),
      );
      expect(
        (await service.publicStateForApp(MaintenanceApp.PARTNER)).blocked,
      ).toBe(true);
    });

    it('leaves the partner app open when only the customer app is blocked (TEST-MNT-003)', async () => {
      await service.update(
        input({ customerApp: app({ active: true, message: 'Down.' }) }),
      );
      expect(
        (await service.publicStateForApp(MaintenanceApp.PARTNER)).blocked,
      ).toBe(false);
    });

    it('leaves the customer app open when only the partner app is blocked (TEST-MNT-004)', async () => {
      await service.update(
        input({ partnerApp: app({ active: true, message: 'Down.' }) }),
      );
      expect(
        (await service.publicStateForApp(MaintenanceApp.CUSTOMER)).blocked,
      ).toBe(false);
    });

    it('blocks both under the global override', async () => {
      await service.update(
        input({
          globalEmergencyActive: true,
          globalEmergencyMessage: 'All down.',
        }),
      );
      expect(
        (await service.publicStateForApp(MaintenanceApp.CUSTOMER)).blocked,
      ).toBe(true);
      expect(
        (await service.publicStateForApp(MaintenanceApp.PARTNER)).blocked,
      ).toBe(true);
    });

    it('reports nothing blocked when nothing is', async () => {
      await service.update(input());
      expect(
        (await service.publicStateForApp(MaintenanceApp.CUSTOMER)).blocked,
      ).toBe(false);
    });

    /**
     * The payload is the disclosure boundary: an anonymous caller sees the
     * outage, never the settings behind it.
     */
    it('exposes nothing beyond what a blocked person is already shown', async () => {
      await service.update(
        input({
          customerApp: app({ active: true, message: 'Down.' }),
          partnerApp: app({ active: true, message: 'Partner-only wording.' }),
          bypassUids: ['secret-tester-uid'],
        }),
      );

      const status = await service.publicStateForApp(MaintenanceApp.CUSTOMER);
      expect(Object.keys(status).sort()).toEqual([
        'blocked',
        'endsAt',
        'message',
        'supportEmail',
        'supportPhone',
        'type',
      ]);
      expect(JSON.stringify(status)).not.toContain('secret-tester-uid');
      expect(JSON.stringify(status)).not.toContain('Partner-only wording');
    });

    it('ignores bypass accounts, which an anonymous caller cannot be', async () => {
      await service.update(
        input({
          customerApp: app({ active: true, message: 'Down.' }),
          bypassUids: ['tester'],
        }),
      );
      // The signed-in tester is exempt…
      expect(
        (await service.effectiveStateForRole('customer', 'tester')).blocked,
      ).toBe(false);
      // …but nobody anonymous is.
      expect(
        (await service.publicStateForApp(MaintenanceApp.CUSTOMER)).blocked,
      ).toBe(true);
    });
  });

  // ── The authenticated path is untouched ─────────────────────────────────

  describe('the existing authenticated path still behaves as before', () => {
    it('derives the app from the role, and never blocks admin or support', async () => {
      await service.update(
        input({
          globalEmergencyActive: true,
          globalEmergencyMessage: 'All down.',
        }),
      );
      const a = actor('admin');
      expect(
        (await service.effectiveStateForRole('admin', a._id)).blocked,
      ).toBe(false);
      expect(
        (await service.effectiveStateForRole('support', a._id)).blocked,
      ).toBe(false);
      expect(
        (await service.effectiveStateForRole('washer', 'w1')).blocked,
      ).toBe(true);
    });

    it('carries the support contact on a blocked answer (TEST-MNT-010)', async () => {
      await service.update(
        input({
          customerApp: app({ active: true, message: 'Down.' }),
          supportEmail: 'help@lalaba.ph',
          supportPhone: '+63 900 000 0000',
        }),
      );
      const status = await service.effectiveStateForRole('customer', 'c1');
      expect(status.supportEmail).toBe('help@lalaba.ph');
      expect(status.supportPhone).toBe('+63 900 000 0000');
    });
  });
});
