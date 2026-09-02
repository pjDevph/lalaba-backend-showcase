import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';

import {
  SupportTicket,
  SupportTicketDocument,
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
  TICKET_ACTIVE_STATUSES,
} from './schemas/support-ticket.schema';
import {
  NoteVisibility,
  SupportTicketNote,
  SupportTicketNoteDocument,
} from './schemas/support-ticket-note.schema';
import {
  SupportTicketEvent,
  SupportTicketEventDocument,
  TicketEventType,
} from './schemas/support-ticket-event.schema';
import { TicketFilterInput } from './dto/ticket-filter.input';
import { CreateTicketInput } from './dto/create-ticket.input';
import { PaginatedTickets, TicketMetrics } from './models/ticket-page.model';
import { User, UserDocument } from '../users/schemas/user.schema';

/**
 * How long support has to send a FIRST customer-visible reply, by priority.
 *
 * First response rather than resolution: a refund can legitimately take days,
 * but silence for days is what turns a complaint into a review. These are
 * working numbers, not a contractual SLA — they exist so the inbox can sort
 * by "who has been waiting longest relative to what we promised" instead of
 * plain age, which buries an urgent ticket behind a week-old low one.
 */
const FIRST_RESPONSE_TARGET_MINUTES: Record<TicketPriority, number> = {
  [TicketPriority.URGENT]: 30,
  [TicketPriority.HIGH]: 2 * 60,
  [TicketPriority.NORMAL]: 8 * 60,
  [TicketPriority.LOW]: 24 * 60,
};

/** Categories that are urgent by nature, whoever files them. */
const AUTO_PRIORITY: Partial<Record<TicketCategory, TicketPriority>> = {
  // Money already left someone's hands.
  [TicketCategory.PAYMENT_DISPUTE]: TicketPriority.HIGH,
  [TicketCategory.WALLET_TOPUP]: TicketPriority.HIGH,
  // Someone's property is damaged or gone.
  [TicketCategory.ORDER_DAMAGED]: TicketPriority.HIGH,
  [TicketCategory.ORDER_MISSING_ITEMS]: TicketPriority.HIGH,
  // Conduct complaints can be safety issues.
  [TicketCategory.COURIER_CONDUCT]: TicketPriority.HIGH,
  [TicketCategory.CUSTOMER_CONDUCT]: TicketPriority.HIGH,
};

@Injectable()
export class SupportTicketsService {
  constructor(
    @InjectModel(SupportTicket.name)
    private readonly ticketModel: Model<SupportTicketDocument>,
    @InjectModel(SupportTicketNote.name)
    private readonly noteModel: Model<SupportTicketNoteDocument>,
    @InjectModel(SupportTicketEvent.name)
    private readonly eventModel: Model<SupportTicketEventDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

  // ── Creation ─────────────────────────────────────────────────────────────

  /**
   * Short ticket number, e.g. `LAL-000042`.
   *
   * Sequential rather than random, because its whole job is to be read aloud
   * over the phone and typed back in. Derived from the current count, which is
   * good enough at this scale and — unlike a separate counter document — has
   * no second thing to keep in sync. A collision under concurrent creation is
   * caught by the unique index and retried below.
   */
  private async nextTicketNumber(): Promise<string> {
    const count = await this.ticketModel.estimatedDocumentCount().exec();
    return `LAL-${String(count + 1).padStart(6, '0')}`;
  }

  async create(input: CreateTicketInput, actor: User): Promise<SupportTicket> {
    // Populated for the same reason as the assignee below: the requester's
    // role is snapshotted onto the ticket and shown in the inbox.
    const requester = await this.userModel
      .findById(input.requesterUid)
      .populate('role')
      .exec();
    if (!requester) {
      throw new NotFoundException('Requester account not found');
    }

    // Explicit priority wins; otherwise some categories carry their own.
    const priority =
      input.priority ?? AUTO_PRIORITY[input.category] ?? TicketPriority.NORMAL;

    // Retry on the unique-index collision two concurrent creates would cause.
    // Bounded, because a persistent failure is a real error and must surface
    // rather than spin.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const ticket = await this.ticketModel.create({
          ticketNumber: await this.nextTicketNumber(),
          subject: input.subject,
          body: input.body,
          source: input.source ?? TicketSource.ADMIN,
          category: input.category,
          priority,
          status: TicketStatus.OPEN,
          requester: {
            uid: String(requester._id),
            displayName:
              `${requester.firstName ?? ''} ${requester.lastName ?? ''}`.trim() ||
              requester.email,
            email: requester.email,
            phone: requester.phoneNumber,
            role: this.roleIdOf(requester),
          },
          // `undefined` rather than `null` — the sub-document's fields are
          // declared optional, and an absent key is what "not linked" means.
          links: {
            orderId: input.orderId ?? undefined,
            providerBranchId: input.providerBranchId ?? undefined,
            paymentReference: input.paymentReference ?? undefined,
          },
        });

        await this.recordEvent(
          String(ticket._id),
          TicketEventType.CREATED,
          actor,
          { toValue: ticket.ticketNumber },
        );
        return ticket;
      } catch (err) {
        const isDuplicate =
          (err as { code?: number })?.code === 11000 && attempt < 4;
        if (!isDuplicate) throw err;
      }
    }
    /* istanbul ignore next -- the loop above either returns or throws */
    throw new BadRequestException('Could not allocate a ticket number');
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async findOne(ticketId: string): Promise<SupportTicket> {
    const ticket = await this.ticketModel.findById(ticketId).exec();
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async find(filter: TicketFilterInput = {}): Promise<PaginatedTickets> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const query: Record<string, unknown> = {};
    if (filter.statuses?.length) {
      query.status = { $in: filter.statuses };
    } else if (filter.activeOnly) {
      query.status = { $in: TICKET_ACTIVE_STATUSES };
    }
    if (filter.sources?.length) query.source = { $in: filter.sources };
    if (filter.priorities?.length) query.priority = { $in: filter.priorities };
    if (filter.categories?.length) query.category = { $in: filter.categories };
    if (filter.orderId) query['links.orderId'] = filter.orderId;
    if (filter.requesterUid) query['requester.uid'] = filter.requesterUid;

    // Distinguishes "assigned to nobody" from "not filtering by assignee".
    // Unassigned is the queue that actually needs watching, so it has to be
    // expressible.
    if (filter.unassignedOnly) {
      query.assignedToUid = null;
    } else if (filter.assignedToUid) {
      query.assignedToUid = filter.assignedToUid;
    }

    if (filter.search?.trim()) {
      const term = filter.search.trim();
      const pattern = new RegExp(escapeRegex(term), 'i');
      query.$or = [
        // Exact on the ticket number: it is the one identifier a caller reads
        // out, and a substring match on it would be noise.
        { ticketNumber: term.toUpperCase() },
        { subject: pattern },
        { 'requester.displayName': pattern },
      ];
    }

    const [data, total] = await Promise.all([
      this.ticketModel
        .find(query)
        // Urgent first, then oldest first WITHIN a priority. Plain
        // newest-first would bury the ticket that has been waiting longest,
        // which is the one most likely to become a public review.
        .sort({ priority: 1, createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.ticketModel.countDocuments(query).exec(),
    ]);

    // Mongo sorts the priority STRING, which alphabetises to
    // HIGH < LOW < NORMAL < URGENT — meaningless. Re-sort by real severity.
    const order: Record<TicketPriority, number> = {
      [TicketPriority.URGENT]: 0,
      [TicketPriority.HIGH]: 1,
      [TicketPriority.NORMAL]: 2,
      [TicketPriority.LOW]: 3,
    };
    data.sort((a, b) => {
      const bySeverity = order[a.priority] - order[b.priority];
      if (bySeverity !== 0) return bySeverity;
      return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
    });

    return { data, total, limit, offset };
  }

  /**
   * Notes for STAFF — both kinds.
   *
   * The customer-facing counterpart is `customerVisibleNotes` below, and they
   * are separate methods on purpose: a single method with a boolean flag is
   * one wrong argument away from showing an agent's private assessment to the
   * person it is about.
   */
  async notes(ticketId: string): Promise<SupportTicketNote[]> {
    return this.noteModel.find({ ticketId }).sort({ createdAt: 1 }).exec();
  }

  /** Notes the requester may see. Never call this for the staff view. */
  async customerVisibleNotes(ticketId: string): Promise<SupportTicketNote[]> {
    return this.noteModel
      .find({ ticketId, visibility: NoteVisibility.CUSTOMER })
      .sort({ createdAt: 1 })
      .exec();
  }

  async events(ticketId: string): Promise<SupportTicketEvent[]> {
    return this.eventModel.find({ ticketId }).sort({ createdAt: 1 }).exec();
  }

  /**
   * The single ongoing thread a requester sees when she opens Support —
   * newest-first, unlike find()'s priority-first admin-queue sort, since here
   * there is exactly one caller and she wants HER most recent conversation,
   * not the platform's most urgent one. WAITING_ON_CUSTOMER counts as active
   * here (unlike TICKET_ACTIVE_STATUSES, which excludes it because the reply
   * clock isn't on the agent) — it is the state where continuing THIS thread
   * matters most, since she's the one who owes the next message.
   */
  async findMostRecentActiveForRequester(
    uid: string,
  ): Promise<SupportTicketDocument | null> {
    return this.ticketModel
      .findOne({
        'requester.uid': uid,
        status: {
          $in: [...TICKET_ACTIVE_STATUSES, TicketStatus.WAITING_ON_CUSTOMER],
        },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Marks the thread read as of now. Silent no-op target for a bad id is
   *  the caller's problem — ownership is asserted before this is ever called. */
  async markRequesterRead(ticketId: string): Promise<boolean> {
    const updated = await this.ticketModel
      .findByIdAndUpdate(ticketId, {
        $set: { requesterLastReadAt: new Date() },
      })
      .exec();
    return updated != null;
  }

  /** Counts for the inbox header. Computed over every ticket, never the page. */
  async metrics(): Promise<TicketMetrics> {
    const [byStatus, unassigned, breached] = await Promise.all([
      this.ticketModel
        .aggregate<{ _id: TicketStatus; n: number }>([
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
        .exec(),
      this.ticketModel
        .countDocuments({
          assignedToUid: null,
          status: { $in: TICKET_ACTIVE_STATUSES },
        })
        .exec(),
      this.countBreached(),
    ]);

    const counts = new Map(byStatus.map((s) => [s._id, s.n]));
    return {
      open: counts.get(TicketStatus.OPEN) ?? 0,
      inProgress: counts.get(TicketStatus.IN_PROGRESS) ?? 0,
      waitingOnCustomer: counts.get(TicketStatus.WAITING_ON_CUSTOMER) ?? 0,
      escalated: counts.get(TicketStatus.ESCALATED) ?? 0,
      unassigned,
      breachedFirstResponse: breached,
    };
  }

  /**
   * Tickets past their first-response target with no reply yet.
   *
   * Only counts tickets where the clock is on us: a ticket waiting on the
   * customer is not support being slow, and counting it would make the number
   * unusable as a staffing signal.
   */
  private async countBreached(): Promise<number> {
    const now = Date.now();
    const candidates = await this.ticketModel
      .find({
        firstResponseAt: null,
        status: { $in: TICKET_ACTIVE_STATUSES },
      })
      .select('priority createdAt')
      .exec();

    return candidates.filter((t) => {
      const target = FIRST_RESPONSE_TARGET_MINUTES[t.priority] ?? 8 * 60;
      const due = (t.createdAt?.getTime() ?? now) + target * 60_000;
      return now > due;
    }).length;
  }

  /** When the first reply was due. Exposed so the panel can show one clock. */
  firstResponseDueAt(ticket: SupportTicket): Date | null {
    if (ticket.firstResponseAt || !ticket.createdAt) return null;
    const target = FIRST_RESPONSE_TARGET_MINUTES[ticket.priority] ?? 8 * 60;
    return new Date(ticket.createdAt.getTime() + target * 60_000);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Add a note.
   *
   * A CUSTOMER-visible note is also the thing that stops the first-response
   * clock — an internal note does not, however thorough, because the person
   * waiting has not heard anything. `firstResponseAt` is stamped once and
   * never overwritten.
   */
  async addNote(
    ticketId: string,
    body: string,
    visibility: NoteVisibility,
    actor: User,
    imageKey?: string,
  ): Promise<SupportTicketNote> {
    const ticket = await this.findOne(ticketId);
    const trimmed = body.trim();
    if (!trimmed && !imageKey) {
      throw new BadRequestException('Note cannot be empty');
    }

    const note = await this.noteModel.create({
      ticketId,
      authorUid: String(actor._id),
      authorName: this.nameOf(actor),
      visibility,
      body: trimmed,
      imageKey: imageKey ?? undefined,
    });

    if (visibility === NoteVisibility.CUSTOMER && !ticket.firstResponseAt) {
      await this.ticketModel
        .findByIdAndUpdate(ticketId, { $set: { firstResponseAt: new Date() } })
        .exec();
    }

    return note;
  }

  /**
   * Uploads an attachment for a note and returns its storage key (to pass
   * into addNote's `imageKey`, same upload-first-reference-next shape as
   * ChatService.uploadChatImage). Ownership of `ticketId` is the caller's
   * responsibility to assert first — this only validates the image itself.
   */
  async uploadTicketImage(
    ticketId: string,
    actor: User,
    base64: string,
    mimeType: string,
  ): Promise<string> {
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
      throw new BadRequestException('Image must be a JPEG, PNG or WebP');
    }
    const data = base64.includes(',') ? base64.split(',')[1] : base64;
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new BadRequestException('No image was provided.');
    }
    const buffer = Buffer.from(data, 'base64');
    // Same 8MB ceiling chat/handover-proof/KYC evidence uploads use.
    const MAX_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException('Image is too large (max 8MB)');
    }

    const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
    const key = `support-tickets/${ticketId}/${actor._id}-${Date.now()}.${ext}`;
    return this.storageProvider.uploadPrivate(buffer, key, mimeType);
  }

  /** Signed read URL for a note's attachment, or null when there is none. */
  async resolveNoteImageUrl(
    imageKey: string | undefined,
  ): Promise<string | null> {
    if (!imageKey) return null;
    return this.storageProvider.getSignedReadUrl(imageKey);
  }

  async changeStatus(
    ticketId: string,
    status: TicketStatus,
    actor: User,
    reason?: string | null,
  ): Promise<SupportTicket> {
    const ticket = await this.findOne(ticketId);
    if (ticket.status === status) return ticket;

    // Escalation without a stated reason is how a ticket bounces between two
    // people who each think the other owns it.
    if (status === TicketStatus.ESCALATED && !reason?.trim()) {
      throw new BadRequestException('Escalation requires a reason');
    }

    const update: Record<string, unknown> = { status };
    if (status === TicketStatus.RESOLVED) {
      update.resolvedAt = new Date();
    } else if (ticket.status === TicketStatus.RESOLVED) {
      // Reopened: clear the stamp so "time to resolution" is not computed
      // from a resolution that was subsequently undone.
      update.resolvedAt = null;
    }

    const updated = await this.ticketModel
      .findByIdAndUpdate(ticketId, { $set: update }, { new: true })
      .exec();

    const wasReopened =
      ticket.status === TicketStatus.RESOLVED ||
      ticket.status === TicketStatus.CLOSED;
    await this.recordEvent(
      ticketId,
      status === TicketStatus.ESCALATED
        ? TicketEventType.ESCALATED
        : status === TicketStatus.RESOLVED
          ? TicketEventType.RESOLVED
          : wasReopened
            ? TicketEventType.REOPENED
            : TicketEventType.STATUS_CHANGED,
      actor,
      { fromValue: ticket.status, toValue: status, reason },
    );

    return updated!;
  }

  /**
   * Assign, reassign or hand back.
   *
   * `assigneeUid: null` unassigns. A reassignment requires a reason for the
   * same reason an escalation does — the next agent needs to know what the
   * last one concluded.
   */
  async assign(
    ticketId: string,
    assigneeUid: string | null,
    actor: User,
    reason?: string | null,
  ): Promise<SupportTicket> {
    const ticket = await this.findOne(ticketId);

    if (assigneeUid == null) {
      const updated = await this.ticketModel
        .findByIdAndUpdate(
          ticketId,
          {
            $set: {
              assignedToUid: null,
              assignedToName: null,
              assignedAt: null,
            },
          },
          { new: true },
        )
        .exec();
      await this.recordEvent(ticketId, TicketEventType.UNASSIGNED, actor, {
        fromValue: ticket.assignedToName ?? ticket.assignedToUid,
        reason,
      });
      return updated!;
    }

    // `.populate('role')` is load-bearing: `role` is an ObjectId ref to the
    // Role collection, so an unpopulated read gives back the ref and the
    // staff check below would reject every assignee.
    const assignee = await this.userModel
      .findById(assigneeUid)
      .populate('role')
      .exec();
    if (!assignee) throw new NotFoundException('Assignee account not found');

    const role = this.roleIdOf(assignee);
    if (role !== 'admin' && role !== 'support') {
      throw new BadRequestException(
        'Tickets can only be assigned to admin or support accounts',
      );
    }

    // Handing a ticket from one agent to another without saying why is the
    // single commonest way context is lost in a support queue.
    if (
      ticket.assignedToUid &&
      ticket.assignedToUid !== assigneeUid &&
      !reason?.trim()
    ) {
      throw new BadRequestException('Reassignment requires a handoff reason');
    }

    const updated = await this.ticketModel
      .findByIdAndUpdate(
        ticketId,
        {
          $set: {
            assignedToUid: assigneeUid,
            assignedToName: this.nameOf(assignee),
            assignedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();

    await this.recordEvent(ticketId, TicketEventType.ASSIGNED, actor, {
      fromValue: ticket.assignedToName ?? ticket.assignedToUid,
      toValue: this.nameOf(assignee),
      reason,
    });
    return updated!;
  }

  async setPriority(
    ticketId: string,
    priority: TicketPriority,
    actor: User,
  ): Promise<SupportTicket> {
    const ticket = await this.findOne(ticketId);
    if (ticket.priority === priority) return ticket;

    const updated = await this.ticketModel
      .findByIdAndUpdate(ticketId, { $set: { priority } }, { new: true })
      .exec();

    await this.recordEvent(ticketId, TicketEventType.PRIORITY_CHANGED, actor, {
      fromValue: ticket.priority,
      toValue: priority,
    });
    return updated!;
  }

  async resolve(
    ticketId: string,
    resolutionCode: string,
    actor: User,
    note?: string | null,
  ): Promise<SupportTicket> {
    await this.ticketModel
      .findByIdAndUpdate(ticketId, { $set: { resolutionCode } })
      .exec();
    // A resolution note is customer-visible by default: "we fixed it" that
    // the customer never sees has not closed anything from their side.
    if (note?.trim()) {
      await this.addNote(ticketId, note, NoteVisibility.CUSTOMER, actor);
    }
    return this.changeStatus(
      ticketId,
      TicketStatus.RESOLVED,
      actor,
      resolutionCode,
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async recordEvent(
    ticketId: string,
    type: TicketEventType,
    actor: User,
    extra: {
      fromValue?: string | null;
      toValue?: string | null;
      reason?: string | null;
    } = {},
  ): Promise<void> {
    await this.eventModel.create({
      ticketId,
      type,
      actorUid: String(actor._id),
      actorName: this.nameOf(actor),
      fromValue: extra.fromValue ?? undefined,
      toValue: extra.toValue ?? undefined,
      reason: extra.reason?.trim() || undefined,
    });
  }

  private nameOf(user: User): string {
    return (
      `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
      user.email ||
      String(user._id)
    );
  }

  /** `role` is a populated document on some paths and a bare id on others. */
  private roleIdOf(user: User): string {
    const role = user.role as unknown;
    if (role && typeof role === 'object' && 'roleId' in role) {
      return String((role as { roleId: string }).roleId);
    }
    return typeof role === 'string' ? role : 'unknown';
  }
}

// Search terms go into a RegExp — escape them so a stray "(" is a literal
// rather than a syntax error, and a ".*" cannot force a collection scan.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
