import { Test, TestingModule } from '@nestjs/testing';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Types } from 'mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SupportTicketsService } from './support-tickets.service';
import {
  SupportTicket,
  SupportTicketSchema,
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from './schemas/support-ticket.schema';
import {
  NoteVisibility,
  SupportTicketNote,
  SupportTicketNoteSchema,
} from './schemas/support-ticket-note.schema';
import {
  SupportTicketEvent,
  SupportTicketEventSchema,
  TicketEventType,
} from './schemas/support-ticket-event.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../users/schemas/role.schema';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';

describe('SupportTicketsService (integration)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let module: TestingModule;
  let service: SupportTicketsService;
  let storageMock: jest.Mocked<StorageProvider>;

  let agent: User;
  let otherAgent: User;
  let customer: User;

  /**
   * Creates a real Role document and a User referencing it. Faking the shape
   * in memory would not exercise the thing that matters: the service resolves
   * a role by POPULATING the ref, so a test that hands it a pre-shaped object
   * would pass while production rejected every assignee.
   */
  const makeUser = async (firstName: string, roleId: string): Promise<User> => {
    // `roleId` is unique, and two support agents share one role — find or
    // create rather than insert per user.
    const role =
      (await connection.models[Role.name].findOne({ roleId }).exec()) ??
      (await connection.models[Role.name].create({
        roleId,
        roleName: roleId,
        description: `${roleId} role`,
      }));
    const uid = new Types.ObjectId().toString();
    const user = await connection.models[User.name].create({
      _id: uid,
      firstName,
      lastName: 'Test',
      email: `${uid}@example.com`,
      phoneNumber: '09171234567',
      role: role._id,
    });
    // The actor passed INTO the service comes from @CurrentUser, which is
    // already populated — mirror that.
    return { ...user.toObject(), role: { roleId } };
  };

  const newTicket = async (
    overrides: Partial<{
      category: TicketCategory;
      priority: TicketPriority;
      subject: string;
      source: TicketSource;
      orderId: string;
    }> = {},
  ) =>
    service.create(
      {
        requesterUid: String(customer._id),
        subject: overrides.subject ?? 'My laundry never arrived',
        body: 'It has been three days.',
        category: overrides.category ?? TicketCategory.ORDER_LATE,
        priority: overrides.priority,
        source: overrides.source,
        orderId: overrides.orderId,
      },
      agent,
    );

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    storageMock = {
      upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
      uploadPrivate: jest.fn(async (_b, key, _ct) => key),
      getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
      delete: jest.fn(async (_key: string): Promise<void> => {}),
    };
    module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(replSet.getUri()),
        MongooseModule.forFeature([
          { name: SupportTicket.name, schema: SupportTicketSchema },
          { name: SupportTicketNote.name, schema: SupportTicketNoteSchema },
          { name: SupportTicketEvent.name, schema: SupportTicketEventSchema },
          { name: User.name, schema: UserSchema },
          { name: Role.name, schema: RoleSchema },
        ]),
      ],
      providers: [
        SupportTicketsService,
        { provide: STORAGE_PROVIDER, useValue: storageMock },
      ],
    }).compile();

    service = module.get(SupportTicketsService);
    connection = module.get<Connection>(getConnectionToken());
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      SupportTicket.name,
      SupportTicketNote.name,
      SupportTicketEvent.name,
      User.name,
      Role.name,
    ]) {
      await connection.models[name].deleteMany({});
    }
    agent = await makeUser('Ada', 'support');
    otherAgent = await makeUser('Ben', 'support');
    customer = await makeUser('Cara', 'customer');
  });

  describe('create', () => {
    it('snapshots the requester and allocates a readable ticket number', async () => {
      const ticket = await newTicket();

      expect(ticket.ticketNumber).toBe('LAL-000001');
      expect(ticket.status).toBe(TicketStatus.OPEN);
      expect(ticket.requester).toMatchObject({
        uid: String(customer._id),
        displayName: 'Cara Test',
        role: 'customer',
      });
    });

    it('numbers tickets sequentially', async () => {
      await newTicket();
      const second = await newTicket();

      expect(second.ticketNumber).toBe('LAL-000002');
    });

    it('records a CREATED event', async () => {
      const ticket = await newTicket();

      const events = await service.events(String(ticket._id));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(TicketEventType.CREATED);
      expect(events[0].actorName).toBe('Ada Test');
    });

    // Some categories are urgent whoever files them — money that already
    // left someone's hands, property damage, conduct complaints.
    it('raises priority for categories that are urgent by nature', async () => {
      const money = await newTicket({
        category: TicketCategory.PAYMENT_DISPUTE,
      });
      const ordinary = await newTicket({ category: TicketCategory.APP_BUG });

      expect(money.priority).toBe(TicketPriority.HIGH);
      expect(ordinary.priority).toBe(TicketPriority.NORMAL);
    });

    it('lets an explicit priority override the category default', async () => {
      const ticket = await newTicket({
        category: TicketCategory.PAYMENT_DISPUTE,
        priority: TicketPriority.LOW,
      });

      expect(ticket.priority).toBe(TicketPriority.LOW);
    });

    it('rejects a ticket for an account that does not exist', async () => {
      await expect(
        service.create(
          {
            requesterUid: new Types.ObjectId().toString(),
            subject: 'x',
            body: 'y',
            category: TicketCategory.OTHER,
          },
          agent,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('notes and the visibility split', () => {
    // The single worst failure this module can have: an agent's private
    // assessment reaching the person it is about.
    it('never returns an internal note from the customer-visible read', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);

      await service.addNote(
        id,
        'Customer sounds like a repeat abuser, check their other accounts.',
        NoteVisibility.INTERNAL,
        agent,
      );
      await service.addNote(
        id,
        'Sorry about this — we are chasing the courier now.',
        NoteVisibility.CUSTOMER,
        agent,
      );

      const staffView = await service.notes(id);
      const customerView = await service.customerVisibleNotes(id);

      expect(staffView).toHaveLength(2);
      expect(customerView).toHaveLength(1);
      expect(customerView[0].body).toContain('chasing the courier');
      expect(
        customerView.some((n) => n.visibility === NoteVisibility.INTERNAL),
      ).toBe(false);
    });

    it('rejects an empty note', async () => {
      const ticket = await newTicket();
      await expect(
        service.addNote(
          String(ticket._id),
          '   ',
          NoteVisibility.INTERNAL,
          agent,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns notes oldest first, so the thread reads as a conversation', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      await service.addNote(id, 'first', NoteVisibility.INTERNAL, agent);
      await service.addNote(id, 'second', NoteVisibility.INTERNAL, agent);

      const notes = await service.notes(id);
      expect(notes.map((n) => n.body)).toEqual(['first', 'second']);
    });
  });

  describe('first response clock', () => {
    it('starts the clock unanswered, with a due time from the priority', async () => {
      const ticket = await newTicket({ priority: TicketPriority.URGENT });

      expect(ticket.firstResponseAt).toBeNull();
      const due = service.firstResponseDueAt(ticket);
      // URGENT is 30 minutes from creation.
      expect(due!.getTime() - ticket.createdAt!.getTime()).toBe(30 * 60_000);
    });

    // An internal note is not an answer, however thorough — the person
    // waiting has not heard anything.
    it('is not stopped by an internal note', async () => {
      const ticket = await newTicket();
      await service.addNote(
        String(ticket._id),
        'Looked into it, courier says delivered.',
        NoteVisibility.INTERNAL,
        agent,
      );

      const after = await service.findOne(String(ticket._id));
      expect(after.firstResponseAt).toBeNull();
    });

    it('is stopped by the first customer-visible note', async () => {
      const ticket = await newTicket();
      await service.addNote(
        String(ticket._id),
        'We are on it.',
        NoteVisibility.CUSTOMER,
        agent,
      );

      const after = await service.findOne(String(ticket._id));
      expect(after.firstResponseAt).toBeInstanceOf(Date);
      // Answered, so there is no longer a due time to count down to.
      expect(service.firstResponseDueAt(after)).toBeNull();
    });

    // Re-stamping on every reply would make a long-running ticket look like
    // it was answered instantly.
    it('is stamped once and never overwritten', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      await service.addNote(id, 'first reply', NoteVisibility.CUSTOMER, agent);
      const first = (await service.findOne(id)).firstResponseAt;

      await service.addNote(id, 'second reply', NoteVisibility.CUSTOMER, agent);
      const second = (await service.findOne(id)).firstResponseAt;

      expect(second).toEqual(first);
    });
  });

  describe('assignment', () => {
    it('assigns to a staff account and records who did it', async () => {
      const ticket = await newTicket();
      const assigned = await service.assign(
        String(ticket._id),
        String(otherAgent._id),
        agent,
      );

      expect(assigned.assignedToUid).toBe(String(otherAgent._id));
      expect(assigned.assignedToName).toBe('Ben Test');
      expect(assigned.assignedAt).toBeInstanceOf(Date);
    });

    // A customer must never end up owning a ticket about themselves.
    it('refuses to assign to a non-staff account', async () => {
      const ticket = await newTicket();
      await expect(
        service.assign(String(ticket._id), String(customer._id), agent),
      ).rejects.toThrow(BadRequestException);
    });

    // Handing a ticket over without saying why is how context is lost.
    it('requires a handoff reason when taking it off someone else', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      await service.assign(id, String(agent._id), agent);

      await expect(
        service.assign(id, String(otherAgent._id), agent),
      ).rejects.toThrow(BadRequestException);

      const ok = await service.assign(
        id,
        String(otherAgent._id),
        agent,
        'Ben handled the earlier ticket from this customer.',
      );
      expect(ok.assignedToUid).toBe(String(otherAgent._id));
    });

    it('needs no reason for the first assignment', async () => {
      const ticket = await newTicket();
      await expect(
        service.assign(String(ticket._id), String(agent._id), agent),
      ).resolves.toBeDefined();
    });

    it('unassigns back to the unowned queue', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      await service.assign(id, String(agent._id), agent);

      const unassigned = await service.assign(id, null, agent);

      expect(unassigned.assignedToUid).toBeNull();
      expect(unassigned.assignedAt).toBeNull();
    });
  });

  describe('status', () => {
    it('requires a reason to escalate', async () => {
      const ticket = await newTicket();
      await expect(
        service.changeStatus(String(ticket._id), TicketStatus.ESCALATED, agent),
      ).rejects.toThrow(BadRequestException);
    });

    it('stamps resolvedAt on resolution', async () => {
      const ticket = await newTicket();
      const resolved = await service.changeStatus(
        String(ticket._id),
        TicketStatus.RESOLVED,
        agent,
      );

      expect(resolved.resolvedAt).toBeInstanceOf(Date);
    });

    // Otherwise "time to resolution" is computed from a resolution that was
    // subsequently undone.
    it('clears resolvedAt when a resolved ticket is reopened', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      await service.changeStatus(id, TicketStatus.RESOLVED, agent);

      const reopened = await service.changeStatus(
        id,
        TicketStatus.IN_PROGRESS,
        agent,
      );

      expect(reopened.resolvedAt).toBeNull();
      const events = await service.events(id);
      expect(events.at(-1)!.type).toBe(TicketEventType.REOPENED);
    });

    it('is a no-op when the status is unchanged', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);
      const before = (await service.events(id)).length;

      await service.changeStatus(id, TicketStatus.OPEN, agent);

      expect((await service.events(id)).length).toBe(before);
    });

    it('records the resolution code and a customer-visible closing note', async () => {
      const ticket = await newTicket();
      const id = String(ticket._id);

      const resolved = await service.resolve(
        id,
        'REFUND_ISSUED',
        agent,
        'We have refunded you in full.',
      );

      expect(resolved.resolutionCode).toBe('REFUND_ISSUED');
      expect(resolved.status).toBe(TicketStatus.RESOLVED);
      const customerNotes = await service.customerVisibleNotes(id);
      expect(customerNotes.at(-1)!.body).toContain('refunded you in full');
    });
  });

  describe('inbox', () => {
    it('sorts urgent first, then oldest first within a priority', async () => {
      const oldNormal = await newTicket({ subject: 'old normal' });
      await newTicket({ subject: 'new normal' });
      const urgent = await newTicket({
        subject: 'urgent',
        priority: TicketPriority.URGENT,
      });

      const { data } = await service.find();

      expect(data[0].ticketNumber).toBe(urgent.ticketNumber);
      expect(data[1].ticketNumber).toBe(oldNormal.ticketNumber);
    });

    it('finds a ticket by the number a caller reads out', async () => {
      const ticket = await newTicket();
      await newTicket();

      const { data, total } = await service.find({
        search: ticket.ticketNumber.toLowerCase(),
      });

      expect(total).toBe(1);
      expect(data[0].ticketNumber).toBe(ticket.ticketNumber);
    });

    it('finds tickets by subject or requester name', async () => {
      await newTicket({ subject: 'Missing socks' });
      await newTicket({ subject: 'Something else' });

      expect((await service.find({ search: 'socks' })).total).toBe(1);
      expect((await service.find({ search: 'cara' })).total).toBe(2);
    });

    it('treats regex metacharacters in a search as literals', async () => {
      await newTicket();
      expect((await service.find({ search: '.*' })).total).toBe(0);
    });

    // "Nobody owns this" is a different question from "no assignee filter".
    it('separates the unassigned queue from an unfiltered list', async () => {
      const assigned = await newTicket();
      await service.assign(String(assigned._id), String(agent._id), agent);
      await newTicket();

      expect((await service.find()).total).toBe(2);
      expect((await service.find({ unassignedOnly: true })).total).toBe(1);
      expect(
        (await service.find({ assignedToUid: String(agent._id) })).total,
      ).toBe(1);
    });

    it('defaults to tickets where the clock is on us', async () => {
      const resolved = await newTicket();
      await service.changeStatus(
        String(resolved._id),
        TicketStatus.RESOLVED,
        agent,
      );
      await newTicket();

      expect((await service.find({ activeOnly: true })).total).toBe(1);
      expect((await service.find()).total).toBe(2);
    });

    it('filters by linked order', async () => {
      const orderId = new Types.ObjectId().toString();
      await newTicket({ orderId });
      await newTicket();

      expect((await service.find({ orderId })).total).toBe(1);
    });

    it('reports a total for the whole match, not the page', async () => {
      for (let i = 0; i < 5; i++) await newTicket();

      const page = await service.find({ limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });

  describe('metrics', () => {
    it('counts by status and surfaces the unowned queue', async () => {
      const a = await newTicket();
      await newTicket();
      await service.assign(String(a._id), String(agent._id), agent);
      await service.changeStatus(
        String(a._id),
        TicketStatus.IN_PROGRESS,
        agent,
      );

      const metrics = await service.metrics();

      expect(metrics.open).toBe(1);
      expect(metrics.inProgress).toBe(1);
      expect(metrics.unassigned).toBe(1);
    });

    // A ticket waiting on the customer is not support being slow, and
    // counting it would make the number useless as a staffing signal.
    it('excludes tickets waiting on the customer from the breach count', async () => {
      const ticket = await newTicket({ priority: TicketPriority.URGENT });
      // Backdate past the 30-minute urgent target. Raw collection: createdAt
      // is immutable under Mongoose's timestamps.
      await connection.models[SupportTicket.name].collection.updateOne(
        { _id: ticket._id as unknown as Types.ObjectId },
        { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } },
      );

      expect((await service.metrics()).breachedFirstResponse).toBe(1);

      await service.changeStatus(
        String(ticket._id),
        TicketStatus.WAITING_ON_CUSTOMER,
        agent,
      );

      expect((await service.metrics()).breachedFirstResponse).toBe(0);
    });

    it('stops counting a breach once a reply has been sent', async () => {
      const ticket = await newTicket({ priority: TicketPriority.URGENT });
      await connection.models[SupportTicket.name].collection.updateOne(
        { _id: ticket._id as unknown as Types.ObjectId },
        { $set: { createdAt: new Date(Date.now() - 60 * 60_000) } },
      );
      expect((await service.metrics()).breachedFirstResponse).toBe(1);

      await service.addNote(
        String(ticket._id),
        'Replying now.',
        NoteVisibility.CUSTOMER,
        agent,
      );

      expect((await service.metrics()).breachedFirstResponse).toBe(0);
    });
  });

  // Backs MySupportTicketsResolver.myOpenSupportTicket — the requester-scoped
  // "single ongoing thread" the customer/partner app reuses until resolved.
  describe('findMostRecentActiveForRequester', () => {
    it('[HP] returns the requester’s most recent active ticket, newest first', async () => {
      const older = await newTicket({ subject: 'First report' });
      // Same requester, created later — must win over `older`.
      const newer = await service.create(
        {
          requesterUid: String(customer._id),
          subject: 'Second report',
          body: 'Different issue.',
          category: TicketCategory.APP_BUG,
        },
        agent,
      );

      const found = await service.findMostRecentActiveForRequester(
        String(customer._id),
      );

      expect(String(found?._id)).toBe(String(newer._id));
      expect(String(found?._id)).not.toBe(String(older._id));
    });

    it('[HP] includes WAITING_ON_CUSTOMER — she is the one who owes the next reply', async () => {
      const ticket = await newTicket();
      await service.changeStatus(
        String(ticket._id),
        TicketStatus.WAITING_ON_CUSTOMER,
        agent,
      );

      const found = await service.findMostRecentActiveForRequester(
        String(customer._id),
      );

      expect(String(found?._id)).toBe(String(ticket._id));
    });

    it('[EC] a RESOLVED ticket is never reused — the next report always starts fresh', async () => {
      const ticket = await newTicket();
      await service.resolve(String(ticket._id), 'FIXED', agent, null);

      const found = await service.findMostRecentActiveForRequester(
        String(customer._id),
      );

      expect(found).toBeNull();
    });

    it('[EC] never returns another requester’s ticket', async () => {
      const stranger = await makeUser('Stranger', 'customer');
      await service.create(
        {
          requesterUid: String(stranger._id),
          subject: 'Not yours',
          body: 'Belongs to someone else.',
          category: TicketCategory.OTHER,
        },
        agent,
      );

      const found = await service.findMostRecentActiveForRequester(
        String(customer._id),
      );

      expect(found).toBeNull();
    });

    it('[EC] returns null when the requester has no tickets at all', async () => {
      const fresh = await makeUser('Fresh', 'customer');
      const found = await service.findMostRecentActiveForRequester(
        String(fresh._id),
      );
      expect(found).toBeNull();
    });
  });

  describe('markRequesterRead', () => {
    it('[HP] stamps requesterLastReadAt', async () => {
      const ticket = await newTicket();
      expect(ticket.requesterLastReadAt ?? null).toBeNull();

      const ok = await service.markRequesterRead(String(ticket._id));

      expect(ok).toBe(true);
      const reloaded = await service.findOne(String(ticket._id));
      expect(reloaded.requesterLastReadAt).toBeInstanceOf(Date);
    });

    it('[EC] returns false for a ticket id that does not exist', async () => {
      const ok = await service.markRequesterRead(String(new Types.ObjectId()));
      expect(ok).toBe(false);
    });
  });
});
