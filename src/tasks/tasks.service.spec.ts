import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { User } from '../users/schemas/user.schema';
import {
  Task,
  TaskSchema,
  TaskPriority,
  TaskCategory,
} from './schemas/task.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Typed mock factories. These fixtures deliberately carry only the fields the
// service under test actually reads, so ONE documented cast lives here at the
// factory seam instead of ~25 `as any` scattered across the call sites — where
// each one silently disabled checking of the whole argument.
const makeUser = (overrides: Partial<User> = {}): User =>
  ({
    _id: 'merchant-uid-001',
    role: { roleId: 'merchant' },
    merchantId: undefined as string | undefined,
    branchIds: [] as string[],
    ...overrides,
  }) as unknown as User;

const makeStaff = (branchIds: string[] = ['branch-A']): User =>
  ({
    _id: 'staff-uid-001',
    role: { roleId: 'staff' },
    merchantId: 'merchant-uid-001',
    branchIds,
  }) as unknown as User;

const baseTask = (overrides: Record<string, any> = {}) => ({
  uid: 'merchant-uid-001',
  branchId: 'branch-A',
  title: 'Clean the kitchen',
  priority: TaskPriority.medium,
  category: TaskCategory.cleaning,
  isCompleted: false,
  isVisibleToStaff: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TasksService (integration)', () => {
  let mongod: MongoMemoryServer;
  let mongoConnection: Connection;
  let service: TasksService;
  let module: TestingModule;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();

    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: Task.name, schema: TaskSchema }]),
      ],
      providers: [TasksService],
    }).compile();

    service = module.get<TasksService>(TasksService);
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

  // -------------------------------------------------------------------------
  // findAll
  // -------------------------------------------------------------------------

  describe('findAll', () => {
    it('[HP] returns all tasks for a given uid', async () => {
      const user = makeUser();
      await service.create(
        {
          title: 'Task 1',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      await service.create(
        {
          title: 'Task 2',
          priority: TaskPriority.high,
          category: TaskCategory.maintenance,
          branchId: 'branch-B',
          isVisibleToStaff: true,
        },
        user,
      );

      const results = await service.findAll('merchant-uid-001');

      expect(results).toHaveLength(2);
      expect(results.every((t) => t.uid === 'merchant-uid-001')).toBe(true);
    });

    it('[EC] returns empty array for unknown uid', async () => {
      const user = makeUser();
      await service.create(
        {
          title: 'Task A',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );

      const results = await service.findAll('non-existent-uid');

      expect(results).toHaveLength(0);
    });

    it('[HP] respects isCompleted filter — returns only incomplete tasks', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Pending',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      await service.create(
        {
          title: 'Done',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      // complete the second task
      const all = await service.findAll('merchant-uid-001');
      const doneTask = all.find((t) => t.title === 'Done')!;
      await service.complete(
        String(doneTask._id),
        'merchant-uid-001',
        'merchant-uid-001',
      );

      const incomplete = await service.findAll('merchant-uid-001', {
        isCompleted: false,
      });
      const complete = await service.findAll('merchant-uid-001', {
        isCompleted: true,
      });

      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].title).toBe('Pending');
      expect(complete).toHaveLength(1);
      expect(complete[0].title).toBe('Done');
    });

    it('[HP] respects branchId filter', async () => {
      const user = makeUser();
      await service.create(
        {
          title: 'Branch A Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      await service.create(
        {
          title: 'Branch B Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-B',
          isVisibleToStaff: true,
        },
        user,
      );

      const results = await service.findAll('merchant-uid-001', {
        branchId: 'branch-A',
      });

      expect(results).toHaveLength(1);
      expect(results[0].branchId).toBe('branch-A');
    });

    it('[HP] respects limit and offset for pagination', async () => {
      const user = makeUser();
      for (let i = 0; i < 5; i++) {
        await service.create(
          {
            title: `Task ${i}`,
            priority: TaskPriority.low,
            category: TaskCategory.general,
            branchId: 'branch-A',
            isVisibleToStaff: true,
          },
          user,
        );
      }

      const page1 = await service.findAll('merchant-uid-001', {
        limit: 2,
        offset: 0,
      });
      const page2 = await service.findAll('merchant-uid-001', {
        limit: 2,
        offset: 2,
      });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // pages should not overlap
      const ids1 = page1.map((t) => String(t._id));
      const ids2 = page2.map((t) => String(t._id));
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it('[HP] respects isVisibleToStaff filter', async () => {
      const user = makeUser();
      await service.create(
        {
          title: 'Visible',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      await service.create(
        {
          title: 'Hidden',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: false,
        },
        user,
      );

      const visible = await service.findAll('merchant-uid-001', {
        isVisibleToStaff: true,
      });
      const hidden = await service.findAll('merchant-uid-001', {
        isVisibleToStaff: false,
      });

      expect(visible).toHaveLength(1);
      expect(visible[0].title).toBe('Visible');
      expect(hidden).toHaveLength(1);
      expect(hidden[0].title).toBe('Hidden');
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('[HP] creates task with uid set to merchant user._id', async () => {
      const user = makeUser();

      const task = await service.create(
        {
          title: 'Merchant Task',
          priority: TaskPriority.high,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );

      expect(task).toBeDefined();
      expect(task.uid).toBe('merchant-uid-001');
      expect(task.title).toBe('Merchant Task');
      expect(Types.ObjectId.isValid(String(task._id))).toBe(true);
    });

    it('[HP] creates task with uid set to staff user.merchantId', async () => {
      const staff = makeStaff(['branch-A']);

      const task = await service.create(
        {
          title: 'Staff Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        staff,
      );

      expect(task).toBeDefined();
      // uid must be the merchantId, NOT the staff's own _id
      expect(task.uid).toBe('merchant-uid-001');
      expect(task.uid).not.toBe('staff-uid-001');
    });

    it('[HP] created task has isCompleted defaulting to false', async () => {
      const user = makeUser();

      const task = await service.create(
        {
          title: 'New Task',
          priority: TaskPriority.urgent,
          category: TaskCategory.delivery,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );

      expect(task.isCompleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update', () => {
    it('[HP] updates task title successfully', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Old Title',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const updated = await service.update(id, 'merchant-uid-001', {
        title: 'New Title',
      });

      expect(updated.title).toBe('New Title');
    });

    it('[HP] updates task priority', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Priority Test',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const updated = await service.update(id, 'merchant-uid-001', {
        priority: TaskPriority.urgent,
      });

      expect(updated.priority).toBe(TaskPriority.urgent);
    });

    it('[EC] throws NotFoundException for unknown task id', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        service.update(fakeId, 'merchant-uid-001', { title: 'Irrelevant' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] throws ForbiddenException when staff branchIds do not include task.branchId', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Branch A Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      // staff only has access to branch-B, not branch-A
      await expect(
        service.update(id, 'merchant-uid-001', { title: 'Hacked' }, [
          'branch-B',
        ]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] merchant with no branchIds restriction can update any task', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Any Branch Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-Z',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      // no branchIds passed = merchant context, no restriction
      const updated = await service.update(id, 'merchant-uid-001', {
        title: 'Merchant Updated',
      });

      expect(updated.title).toBe('Merchant Updated');
    });
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('[HP] deletes an existing task and returns it', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'To Be Deleted',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const deleted = await service.delete(id, 'merchant-uid-001');

      expect(deleted).toBeDefined();
      expect(String(deleted._id)).toBe(id);

      // confirm it is actually gone
      const remaining = await service.findAll('merchant-uid-001');
      expect(remaining.find((t) => String(t._id) === id)).toBeUndefined();
    });

    it('[EC] throws NotFoundException when task does not exist', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(service.delete(fakeId, 'merchant-uid-001')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[EC] throws ForbiddenException when staff branchIds do not include task.branchId', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Protected Task',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      await expect(
        service.delete(id, 'merchant-uid-001', ['branch-B', 'branch-C']),
      ).rejects.toThrow(ForbiddenException);

      // ensure the task was NOT deleted
      const remaining = await service.findAll('merchant-uid-001');
      expect(remaining.find((t) => String(t._id) === id)).toBeDefined();
    });

    it('[EC] throws NotFoundException when uid does not match task owner', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Owner Check',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      await expect(service.delete(id, 'wrong-uid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  describe('complete', () => {
    it('[HP] marks task as complete with completedBy and completedAt', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Completable',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const completed = await service.complete(
        id,
        'merchant-uid-001',
        'merchant-uid-001',
      );

      expect(completed.isCompleted).toBe(true);
      expect(completed.completedBy).toBe('merchant-uid-001');
      expect(completed.completedAt).toBeInstanceOf(Date);
    });

    it('[HP] stores noteText and photoUri when provided', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'With Note',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const completed = await service.complete(
        id,
        'merchant-uid-001',
        'merchant-uid-001',
        'Looks good',
        'https://cdn.example.com/photo.jpg',
      );

      expect(completed.noteText).toBe('Looks good');
      expect(completed.photoUri).toBe('https://cdn.example.com/photo.jpg');
    });

    it('[EC] throws NotFoundException for unknown task id', async () => {
      const fakeId = new Types.ObjectId().toString();

      await expect(
        service.complete(fakeId, 'merchant-uid-001', 'merchant-uid-001'),
      ).rejects.toThrow(NotFoundException);
    });

    it('[EC] merchant (branchIds undefined) can complete a task on any branch', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Cross Branch',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-Z',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      // branchIds = undefined means merchant; should NOT throw
      const completed = await service.complete(
        id,
        'merchant-uid-001',
        'merchant-uid-001',
        undefined,
        undefined,
        undefined,
      );

      expect(completed.isCompleted).toBe(true);
    });

    it('[EC] staff without matching branchId throws ForbiddenException', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Staff Cannot Complete',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      // staff has branch-B and branch-C but not branch-A
      await expect(
        service.complete(
          id,
          'merchant-uid-001',
          'staff-uid-001',
          undefined,
          undefined,
          ['branch-B', 'branch-C'],
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('[HP] staff with matching branchId can complete the task', async () => {
      const user = makeUser();
      const created = await service.create(
        {
          title: 'Staff Can Complete',
          priority: TaskPriority.low,
          category: TaskCategory.general,
          branchId: 'branch-A',
          isVisibleToStaff: true,
        },
        user,
      );
      const id = String(created._id);

      const completed = await service.complete(
        id,
        'merchant-uid-001',
        'staff-uid-001',
        undefined,
        undefined,
        ['branch-A', 'branch-B'],
      );

      expect(completed.isCompleted).toBe(true);
      expect(completed.completedBy).toBe('staff-uid-001');
    });
  });
});
