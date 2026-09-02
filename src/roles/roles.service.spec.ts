import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection } from 'mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

/**
 * RolesGuard matches on `role.roleId`, which makes this collection load-bearing
 * for every authenticated request. deleteRole is @Roles('admin') and so is
 * createRole — so removing the admin row locks the panel permanently, with no
 * in-app path back. These cover that and the referential case beside it.
 */
describe('RolesService (integration)', () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let service: RolesService;
  let module: TestingModule;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongod.getUri()),
        MongooseModule.forFeature([
          { name: Role.name, schema: RoleSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [RolesService],
    }).compile();

    service = module.get<RolesService>(RolesService);
    connection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  afterEach(async () => {
    for (const key in connection.collections) {
      await connection.collections[key].deleteMany({});
    }
  });

  /** Runs the same bootstrap seeding the app performs on boot. */
  async function seedSystemRoles() {
    await service.onApplicationBootstrap();
  }

  async function roleIdOf(roleId: string): Promise<string> {
    const RoleModel = connection.model(Role.name, RoleSchema);
    const doc = await RoleModel.findOne({ roleId }).exec();
    return String(doc!._id);
  }

  describe('onApplicationBootstrap', () => {
    it('[HP] seeds the system roles and is idempotent across restarts', async () => {
      await seedSystemRoles();
      const first = await service.findAll();
      expect(first.length).toBeGreaterThanOrEqual(7);

      await seedSystemRoles();
      const second = await service.findAll();
      expect(second.length).toBe(first.length);
    });
  });

  describe('delete', () => {
    it('[SEC] refuses to delete the admin role — deleting it locks every admin out for good', async () => {
      await seedSystemRoles();
      const adminId = await roleIdOf('admin');

      await expect(service.delete(adminId)).rejects.toThrow(
        BadRequestException,
      );

      // Still present. A partial delete here would be as bad as a full one.
      const survivors = await service.findAll();
      expect(survivors.some((r) => r.roleId === 'admin')).toBe(true);
    });

    it.each([
      'admin',
      'merchant',
      'washer',
      'staff',
      'customer',
      'courier',
      'support',
    ])('[SEC] refuses to delete the seeded "%s" role', async (roleId) => {
      await seedSystemRoles();
      const id = await roleIdOf(roleId);

      await expect(service.delete(id)).rejects.toThrow(
        /system role and cannot be deleted/i,
      );
    });

    it('[SEC] refuses to delete a custom role that accounts still hold', async () => {
      const custom = await service.create({
        roleId: 'finance',
        roleName: 'Finance',
        description: 'Money only',
      });
      const customId = String((custom as { _id: unknown })._id);

      const UserModel = connection.model(User.name, UserSchema);
      await UserModel.create({
        _id: 'holder-1',
        email: 'holder@lalaba.test',
        firstName: 'A',
        lastName: 'B',
        phoneNumber: '09171234567',
        role: customId,
        isActive: true,
      });

      await expect(service.delete(customId)).rejects.toThrow(
        /still use this role/i,
      );
    });

    it('[HP] deletes an unused custom role', async () => {
      const custom = await service.create({
        roleId: 'finance',
        roleName: 'Finance',
        description: 'Money only',
      });
      const customId = String((custom as { _id: unknown })._id);

      await expect(service.delete(customId)).resolves.toBe(true);
      const remaining = await service.findAll();
      expect(remaining.some((r) => r.roleId === 'finance')).toBe(false);
    });

    it('[EC] throws NotFoundException for a role that does not exist', async () => {
      await expect(service.delete('6a11bcb8ffd7d2160b1e5000')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('[EC] rejects a duplicate roleId', async () => {
      await seedSystemRoles();
      await expect(
        service.create({
          roleId: 'admin',
          roleName: 'Admin again',
          description: 'dupe',
        }),
      ).rejects.toThrow(/already exists/i);
    });
  });
});
