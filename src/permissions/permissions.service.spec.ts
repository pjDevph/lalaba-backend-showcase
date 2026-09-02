// Mock the Permission schema BEFORE any imports that would pull in @nestjs/graphql
jest.mock('./schemas/permission.schema', () => ({
  Permission: class Permission {},
  PermissionSchema: require('mongoose').Schema(
    {
      permissionName: { type: String, required: true, unique: true },
      description: { type: String, required: true },
    },
    { timestamps: true },
  ),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { PermissionsService } from './permissions.service';
import { Permission, PermissionSchema } from './schemas/permission.schema';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<{ permissionName: string; description: string }> = {},
) {
  return {
    permissionName: 'READ_USERS',
    description: 'Allows reading the users list',
    ...overrides,
  };
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('PermissionsService (integration)', () => {
  let mongod: MongoMemoryServer;
  let module: TestingModule;
  let service: PermissionsService;
  let mongoConnection: Connection;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Permission.name, schema: PermissionSchema },
        ]),
      ],
      providers: [
        PermissionsService,
        // PermissionsService caches the catalogue; the suite is about
        // persistence, so a no-op cache keeps every read hitting Mongo.
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<PermissionsService>(PermissionsService);
    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await mongoConnection.dropDatabase();
    await module.close();
    await mongod.stop();
  });

  afterEach(async () => {
    const collections = mongoConnection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('[HP] saves a permission with correct fields', async () => {
      const input = makeInput();
      const result = await service.create(input);

      expect(result.permissionName).toBe('READ_USERS');
      expect(result.description).toBe('Allows reading the users list');
      expect((result as any)._id).toBeDefined();
    });

    it('[HP] persisted document is retrievable from the database', async () => {
      const input = makeInput({ permissionName: 'WRITE_ORDERS' });
      const created = await service.create(input);

      const found = await service.findById(String(created._id));
      expect(found.permissionName).toBe('WRITE_ORDERS');
    });

    it('[EC] throws ConflictException when permissionName already exists', async () => {
      const input = makeInput({ permissionName: 'DUPLICATE_PERM' });
      await service.create(input);

      await expect(service.create(input)).rejects.toThrow(ConflictException);
    });

    it('[EC] ConflictException message contains the duplicate permissionName', async () => {
      const input = makeInput({ permissionName: 'CONFLICT_NAME' });
      await service.create(input);

      await expect(service.create(input)).rejects.toThrow(
        `Permission "CONFLICT_NAME" already exists`,
      );
    });
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('[HP] returns an empty array when no permissions exist', async () => {
      const result = await service.findAll();
      expect(result).toEqual([]);
    });

    it('[HP] returns all persisted permissions', async () => {
      await service.create(makeInput({ permissionName: 'ALPHA' }));
      await service.create(makeInput({ permissionName: 'BETA' }));

      const result = await service.findAll();
      expect(result).toHaveLength(2);
    });

    it('[HP] returns permissions sorted alphabetically by permissionName', async () => {
      await service.create(makeInput({ permissionName: 'ZEBRA_PERM' }));
      await service.create(makeInput({ permissionName: 'APPLE_PERM' }));
      await service.create(makeInput({ permissionName: 'MANGO_PERM' }));

      const result = await service.findAll();
      const names = result.map((p) => p.permissionName);
      expect(names).toEqual(['APPLE_PERM', 'MANGO_PERM', 'ZEBRA_PERM']);
    });
  });

  // ── findById ───────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('[HP] returns the correct permission by id', async () => {
      const created = await service.create(
        makeInput({ permissionName: 'FIND_ME' }),
      );
      const id = String(created._id);

      const found = await service.findById(id);
      expect(found.permissionName).toBe('FIND_ME');
      expect(String(found._id)).toBe(id);
    });

    it('[EC] throws NotFoundException for a non-existent id', async () => {
      const nonExistentId = '000000000000000000000001';
      await expect(service.findById(nonExistentId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] NotFoundException message says "Permission not found"', async () => {
      const nonExistentId = '000000000000000000000002';
      await expect(service.findById(nonExistentId)).rejects.toThrow(
        'Permission not found',
      );
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('[HP] changes permissionName and description', async () => {
      const created = await service.create(
        makeInput({ permissionName: 'OLD_NAME' }),
      );
      const id = String(created._id);

      const updated = await service.update(id, {
        permissionName: 'NEW_NAME',
        description: 'Updated description',
      });

      expect(updated.permissionName).toBe('NEW_NAME');
      expect(updated.description).toBe('Updated description');
    });

    it('[HP] updating with the same permissionName does NOT throw', async () => {
      const created = await service.create(
        makeInput({ permissionName: 'SAME_NAME' }),
      );
      const id = String(created._id);

      await expect(
        service.update(id, {
          permissionName: 'SAME_NAME',
          description: 'New desc',
        }),
      ).resolves.toBeDefined();
    });

    it('[EC] throws ConflictException when new permissionName is taken by another document', async () => {
      await service.create(makeInput({ permissionName: 'TAKEN_PERM' }));
      const other = await service.create(
        makeInput({ permissionName: 'OTHER_PERM' }),
      );
      const otherId = String(other._id);

      await expect(
        service.update(otherId, { permissionName: 'TAKEN_PERM' }),
      ).rejects.toThrow(ConflictException);
    });

    it('[EC] ConflictException on update contains the taken permissionName', async () => {
      await service.create(makeInput({ permissionName: 'BLOCKED_PERM' }));
      const other = await service.create(
        makeInput({ permissionName: 'MOVABLE_PERM' }),
      );
      const otherId = String(other._id);

      await expect(
        service.update(otherId, { permissionName: 'BLOCKED_PERM' }),
      ).rejects.toThrow(`Permission "BLOCKED_PERM" already exists`);
    });

    it('[EC] throws NotFoundException when updating a non-existent id', async () => {
      const nonExistentId = '000000000000000000000003';
      await expect(
        service.update(nonExistentId, { description: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('[HP] removes the permission and returns true', async () => {
      const created = await service.create(
        makeInput({ permissionName: 'TO_DELETE' }),
      );
      const id = String(created._id);

      const result = await service.delete(id);
      expect(result).toBe(true);
    });

    it('[HP] document is no longer findable after deletion', async () => {
      const created = await service.create(
        makeInput({ permissionName: 'DELETED_PERM' }),
      );
      const id = String(created._id);

      await service.delete(id);

      await expect(service.findById(id)).rejects.toThrow(NotFoundException);
    });

    it('[EC] throws NotFoundException when deleting a non-existent id', async () => {
      const nonExistentId = '000000000000000000000004';
      await expect(service.delete(nonExistentId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] NotFoundException message says "Permission not found"', async () => {
      const nonExistentId = '000000000000000000000005';
      await expect(service.delete(nonExistentId)).rejects.toThrow(
        'Permission not found',
      );
    });
  });
});
