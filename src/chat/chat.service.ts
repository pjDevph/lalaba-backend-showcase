import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Conversation,
  ConversationDocument,
  ConversationKind,
  ChatLegType,
} from './schemas/conversation.schema';
import {
  Message,
  MessageDocument,
  ChatSenderRole,
} from './schemas/message.schema';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
} from '../washer/schemas/washer-profile.schema';
import { washerStoreName } from '../washer/washer-name.util';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import {
  ProviderType,
  OrderStatus,
} from '../online-orders/schemas/order-status.enum';
import { activeCourierLeg } from '../online-orders/courier-access.util';
import {
  SendMessageInput,
  StartConversationInput,
  StartCourierConversationInput,
} from './dto/chat.input';
import { AdminConversationsInput } from './dto/admin-conversations.input';
import { PaginatedConversations } from './models/paginated-conversations.model';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';

// An order is "concluded" once the laundry is back with the customer (or the
// order was cancelled/rejected/refunded). At that point the customer↔provider
// chat session for that order is over: readable in history, closed to new
// messages. A later order opens a brand-new thread.
const CONCLUDED_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DELIVERED_TO_CUSTOMER,
  OrderStatus.CUSTOMER_PICKUP_VERIFIED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.REFUNDED,
  OrderStatus.DISPUTED,
]);

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
  ) {}

  private roleIdOf(user: User): string {
    return (user.role as unknown as Role)?.roleId ?? '';
  }

  private senderRoleOf(user: User): ChatSenderRole {
    const r = this.roleIdOf(user);
    if (r === 'merchant') return ChatSenderRole.MERCHANT;
    if (r === 'washer') return ChatSenderRole.WASHER;
    if (r === 'courier') return ChatSenderRole.COURIER;
    return ChatSenderRole.CUSTOMER;
  }

  private isCustomer(user: User): boolean {
    return this.roleIdOf(user) === 'customer';
  }

  /**
   * SEC-005 — is `user` genuinely a party to this order?
   *
   * The order's customer, the provider owner, staff of the provider's tenant
   * (merchantId or a branch membership), or a courier currently assigned to
   * either leg. Used to prove a caller may bind a chat thread to an orderId
   * they supplied, instead of trusting the id.
   */
  /**
   * The provider this caller speaks FOR.
   *
   * An owner speaks for themselves. A staff member speaks for the business
   * that employs them — never for their own uid, which owns no conversations
   * and would resolve to an empty inbox.
   *
   * This is what makes a branch's thread continuous: three employees and the
   * owner all answer the same conversation, rather than the customer accruing
   * a separate thread per person who happens to be on shift.
   */
  private providerUidFor(user: User): string {
    const roleId = (user.role as unknown as Role)?.roleId;
    return roleId === 'staff' && user.merchantId ? user.merchantId : user._id;
  }

  /** Branches a caller may see conversations for. `null` = unrestricted. */
  private allowedBranchIds(
    user: User,
    activeBranchId?: string | null,
  ): string[] | null {
    const roleId = (user.role as unknown as Role)?.roleId;
    if (roleId !== 'staff') return null;
    const assigned = (user.branchIds ?? []).map(String);
    // The branch their approved device pins them to, and only if it is still
    // one they are assigned. A stale device sees nothing rather than everything.
    if (activeBranchId && assigned.includes(String(activeBranchId))) {
      return [String(activeBranchId)];
    }
    return [];
  }

  private isOrderParticipant(order: OnlineOrder, user: User): boolean {
    const uid = user._id;
    if (!uid) return false;
    if (order.customer?.uid === uid) return true;
    if (order.provider?.providerUid === uid) return true;
    if (user.merchantId && user.merchantId === order.provider?.providerUid) {
      return true;
    }
    if (
      (user.branchIds ?? [])
        .map(String)
        .includes(String(order.provider?.branchId))
    ) {
      return true;
    }
    return (
      order.pickupAssignment?.assignedStaffUid === uid ||
      order.returnAssignment?.assignedStaffUid === uid
    );
  }

  /**
   * Has the leg this rider thread belongs to been handed over?
   *
   * `LegAssignment.completedAt` is the handover stamp, so this is true the
   * moment the pickup is collected / the delivery is dropped off — which is
   * where the courier chat session is meant to end for BOTH sides, not just the
   * rider. A leg reassigned to a different rider also ends the old rider's
   * thread: the conversation belongs to one person on one leg.
   */
  private isCourierLegOver(
    convo: Pick<Conversation, 'providerUid' | 'legType'>,
    order: OnlineOrder | null,
  ): boolean {
    if (!order) return true;
    if (CONCLUDED_ORDER_STATUSES.has(order.status)) return true;
    const assignment =
      convo.legType === ChatLegType.RETURN
        ? order.returnAssignment
        : order.pickupAssignment;
    if (assignment?.assignedStaffUid !== convo.providerUid) return true;
    return assignment.completedAt != null;
  }

  /**
   * Is this rider thread still open for `user`?
   *
   * A courier↔customer thread is scoped to one leg: it opens when the rider
   * starts navigation and expires the moment that leg is handed over. Only the
   * RIDER's access expires — the customer keeps the thread in their history, and
   * non-courier threads are unaffected.
   *
   * Comparing against the thread's own `legType` is what stops a rider who also
   * has the return leg from reviving the pickup thread, and vice versa.
   */
  private isCourierThreadLive(
    convo: Pick<Conversation, 'kind' | 'providerUid' | 'orderId' | 'legType'>,
    user: User,
    order: OnlineOrder | null,
  ): boolean {
    if (convo.kind !== ConversationKind.COURIER) return true;
    if (convo.providerUid !== user._id) return true; // caller is the customer
    if (!order) return false;
    const live = activeCourierLeg(order, user._id);
    if (!live) return false;
    return (
      live === (convo.legType === ChatLegType.PICKUP ? 'pickup' : 'return')
    );
  }

  // Conversations for the caller — customer sees theirs, provider sees theirs.
  // Completed legs are NOT filtered out: the rider keeps the thread in their
  // list, greyed out via the `ended` field, so past jobs remain readable.
  async myConversations(
    user: User,
    activeBranchId?: string | null,
  ): Promise<Conversation[]> {
    if (this.isCustomer(user)) {
      return this.conversationModel
        .find({ customerUid: user._id })
        .sort({ lastMessageAt: -1 })
        .exec();
    }

    const filter: Record<string, unknown> = {
      providerUid: this.providerUidFor(user),
    };
    // Staff answer for the business, but only on the branch they are working.
    const branches = this.allowedBranchIds(user, activeBranchId);
    if (branches !== null) filter.branchId = { $in: branches };

    return this.conversationModel
      .find(filter)
      .sort({ lastMessageAt: -1 })
      .exec();
  }

  /**
   * ADMIN/SUPPORT-ONLY: platform-wide conversation oversight, unscoped to any
   * one participant — unlike myConversations, which only ever returns the
   * caller's own threads. Read-only surface for this pass: no reply-as-admin
   * mutation exists yet (see adminMessages below).
   */
  async adminListConversations(
    filter: AdminConversationsInput = {},
  ): Promise<PaginatedConversations> {
    const { search, limit = 20, offset = 0 } = filter;
    const safeLimit = Math.min(limit ?? 20, 100);
    const query: Record<string, any> = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { customerName: { $regex: escaped, $options: 'i' } },
        { providerName: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.conversationModel
        .find(query)
        .sort({ lastMessageAt: -1 })
        .skip(offset)
        .limit(safeLimit)
        .exec(),
      this.conversationModel.countDocuments(query).exec(),
    ]);
    return { data, total, limit: safeLimit, offset };
  }

  /**
   * ADMIN/SUPPORT-ONLY: read a thread without the participant-membership
   * check `messages()` enforces (admin is never customerUid/providerUid on
   * any thread) and, deliberately, WITHOUT touching either side's unread
   * counter — an admin opening a thread to look must never clear the badge
   * the actual customer or provider sees.
   */
  async adminMessages(conversationId: string): Promise<Message[]> {
    const convo = await this.conversationModel.findById(conversationId).exec();
    if (!convo) throw new NotFoundException('Conversation not found');
    return this.messageModel
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * A support/admin agent replying into an existing thread as themselves —
   * not as the customer or the provider. Deliberately its own method rather
   * than reusing sendMessage: that method derives the sender's role from the
   * caller's account role (senderRoleOf), which has no admin/support case and
   * would silently mislabel the message as CUSTOMER, and it also requires the
   * caller to be a thread participant, which an admin never is.
   *
   * Bumps BOTH sides' unread counters — unlike adminMessages (read-only,
   * touches neither), an actual reply is something both the customer and the
   * provider need to see.
   */
  async adminSendMessage(
    actor: User,
    conversationId: string,
    text: string,
  ): Promise<Message> {
    const convo = await this.conversationModel.findById(conversationId).exec();
    if (!convo) throw new NotFoundException('Conversation not found');

    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Message must have text');

    const message = await this.messageModel.create({
      conversationId: String(convo._id),
      senderUid: actor._id,
      senderRole: ChatSenderRole.SUPPORT,
      text: trimmed,
    });

    await this.conversationModel
      .updateOne(
        { _id: convo._id },
        {
          $set: { lastMessageText: trimmed, lastMessageAt: message.createdAt },
          $inc: { customerUnread: 1, providerUnread: 1 },
        },
      )
      .exec();

    return message;
  }

  private async findParticipantConversation(
    conversationId: string,
    user: User,
    activeBranchId?: string | null,
  ): Promise<ConversationDocument> {
    const convo = await this.conversationModel.findById(conversationId).exec();
    if (!convo) throw new NotFoundException('Conversation not found');
    // A staff member is a participant through their employer, not their own
    // uid — and only for a branch they are actually working.
    const speaksFor = this.providerUidFor(user);
    const branches = this.allowedBranchIds(user, activeBranchId);
    const branchOk =
      branches === null || branches.includes(String(convo.branchId));
    const isParticipant =
      convo.customerUid === user._id ||
      (convo.providerUid === speaksFor && branchOk);
    if (!isParticipant) {
      throw new ForbiddenException('You are not part of this conversation');
    }

    return convo;
  }

  /**
   * Has this thread's session ended for `user`?
   *
   * An ended thread stays readable — either side can still open it and review
   * what was said — but is closed to new messages. Only sending is blocked;
   * history is never taken away.
   *
   *  - COURIER threads end for BOTH sides when the leg is handed over — the
   *    session is the leg, so it closes when the pickup is collected and again
   *    when the delivery is dropped off. The rider's window is narrower still:
   *    it also hasn't opened before they hit "Start navigation".
   *  - PROVIDER threads end for BOTH sides once the order concludes (delivered /
   *    picked up / completed / cancelled). Each order is its own session, so the
   *    customer's next order with the same provider opens a fresh thread rather
   *    than reviving this one.
   */
  async isThreadEnded(
    convo: Pick<Conversation, 'kind' | 'providerUid' | 'orderId' | 'legType'>,
    user: User,
  ): Promise<boolean> {
    if (convo.kind === ConversationKind.COURIER) {
      const order = convo.orderId
        ? await this.orderModel.findById(convo.orderId).exec()
        : null;
      // Customer side: open from the moment a rider is assigned until that leg
      // is handed over. (The rider's own window opens later — at "Start
      // navigation" — which isCourierThreadLive enforces.)
      if (convo.providerUid !== user._id) {
        return this.isCourierLegOver(convo, order);
      }
      return !this.isCourierThreadLive(convo, user, order);
    }

    // PROVIDER thread — ended for everyone once its order is concluded. A legacy
    // thread with no orderId (pre-migration) is left open.
    if (!convo.orderId) return false;
    const order = await this.orderModel.findById(convo.orderId).exec();
    if (!order) return false;
    return CONCLUDED_ORDER_STATUSES.has(order.status);
  }

  // Messages for a conversation, oldest first. Clears the caller's unread count.
  async messages(
    conversationId: string,
    user: User,
    activeBranchId?: string | null,
  ): Promise<Message[]> {
    const convo = await this.findParticipantConversation(
      conversationId,
      user,
      activeBranchId,
    );
    const unreadField = this.isCustomer(user)
      ? 'customerUnread'
      : 'providerUnread';
    if ((convo as any)[unreadField] > 0) {
      await this.conversationModel
        .updateOne({ _id: convo._id }, { $set: { [unreadField]: 0 } })
        .exec();
    }
    return this.messageModel
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .exec();
  }

  async sendMessage(
    user: User,
    input: SendMessageInput,
    activeBranchId?: string | null,
  ): Promise<Message> {
    const convo = await this.findParticipantConversation(
      input.conversationId,
      user,
    );
    if (await this.isThreadEnded(convo, user)) {
      throw new ForbiddenException(
        'This conversation has ended — this order is complete.',
      );
    }

    const text = input.text?.trim() ?? '';
    const imageKey = input.imageKey?.trim() || undefined;
    if (!text && !imageKey) {
      throw new BadRequestException('Message must have text or an image');
    }

    const message = await this.messageModel.create({
      conversationId: String(convo._id),
      senderUid: user._id,
      senderRole: this.senderRoleOf(user),
      text,
      imageKey,
    });

    // Update thread summary + bump the OTHER side's unread counter. An
    // image-only message shows a placeholder in the thread list preview.
    const recipientUnread = this.isCustomer(user)
      ? 'providerUnread'
      : 'customerUnread';
    const summaryText = text || (imageKey ? 'Photo' : '');
    await this.conversationModel
      .updateOne(
        { _id: convo._id },
        {
          $set: {
            lastMessageText: summaryText,
            lastMessageAt: message.createdAt,
          },
          $inc: { [recipientUnread]: 1 },
        },
      )
      .exec();

    return message;
  }

  /**
   * Uploads one chat image and returns its private storage key. Mirrors the
   * handover-proof flow exactly: the client uploads first, gets the key back,
   * then calls sendMessage with imageKey set — this mutation never creates a
   * message itself.
   *
   * Gated by the same participant + "thread not ended" checks sendMessage
   * applies, checked BEFORE the upload runs — no point pushing bytes to
   * storage for a message that could never be attached to the thread.
   */
  async uploadChatImage(
    user: User,
    conversationId: string,
    base64: string,
    mimeType: string,
    activeBranchId?: string | null,
  ): Promise<string> {
    const convo = await this.findParticipantConversation(
      conversationId,
      user,
      activeBranchId,
    );
    if (await this.isThreadEnded(convo, user)) {
      throw new ForbiddenException(
        'This conversation has ended — this order is complete.',
      );
    }

    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
      throw new BadRequestException('Image must be a JPEG, PNG or WebP');
    }
    const data = base64.includes(',') ? base64.split(',')[1] : base64;
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new BadRequestException('No image was provided.');
    }
    const buffer = Buffer.from(data, 'base64');
    // Same 8MB ceiling uploadHandoverProof applies to evidence photos — a
    // phone-camera JPEG comfortably fits well under this.
    const MAX_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException('Image is too large (max 8MB)');
    }

    const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
    const key = `chat/${conversationId}/${user._id}-${Date.now()}.${ext}`;
    return this.storageProvider.uploadPrivate(buffer, key, mimeType);
  }

  /**
   * Signed read URL for a message's attached image, or null when there is no
   * image or the viewer isn't a participant of the message's thread. Returns
   * null rather than throwing on an unauthorized viewer, so a resolver field
   * failing never 500s an entire message-list query.
   */
  async resolveMessageImageUrl(
    message: Pick<Message, 'imageKey' | 'conversationId'>,
    user: User,
  ): Promise<string | null> {
    if (!message.imageKey) return null;
    try {
      await this.findParticipantConversation(message.conversationId, user);
    } catch {
      return null;
    }
    return this.storageProvider.getSignedReadUrl(message.imageKey);
  }

  // Find-or-create the customer↔provider thread for ONE order. Each order is its
  // own chat session — a new order opens a new thread rather than reviving the
  // customer's previous conversation with that provider.
  async startConversation(
    customer: User,
    input: StartConversationInput,
  ): Promise<Conversation> {
    if (!this.isCustomer(customer)) {
      throw new ForbiddenException('Only customers can start a conversation');
    }

    // SEC-005: orderId arrived straight from the client and was written onto
    // the conversation without the order ever being loaded. Any customer could
    // therefore bind a thread to somebody else's orderId — and every
    // downstream check (the CONCLUDED_ORDER_STATUSES session window in
    // sendMessage, the courier-leg lookups) reads that order, so the forged
    // binding leaked another customer's order state and kept a thread alive on
    // their timeline. Load it and prove participation before binding.
    const order = await this.orderModel.findById(input.orderId).exec();
    if (!order) throw new NotFoundException('Order not found');
    if (!this.isOrderParticipant(order, customer)) {
      throw new ForbiddenException('Not your order');
    }
    // The thread must also be bound to the provider that actually holds the
    // order, or the customer could point their own order's thread at an
    // unrelated branch.
    if (
      String(order.provider.branchId) !== String(input.branchId) ||
      order.provider.providerType !== input.providerType
    ) {
      throw new BadRequestException(
        'This order does not belong to that provider',
      );
    }

    let providerUid: string;
    let providerName: string;
    if (input.providerType === ProviderType.WASHER) {
      const washer = await this.washerModel
        .findOne({ branchId: input.branchId })
        .exec();
      if (!washer) throw new NotFoundException('Home washer not found');
      providerUid = washer.uid;
      // The shop's name, matching the thread title the customer opened it from.
      providerName = washerStoreName(washer);
    } else {
      const branch = await this.branchModel.findById(input.branchId).exec();
      if (!branch) throw new NotFoundException('Laundromat not found');
      providerUid = branch.uid;
      providerName = branch.branchName;
    }

    const existing = await this.conversationModel
      .findOne({
        customerUid: customer._id,
        providerUid,
        orderId: input.orderId,
        kind: ConversationKind.PROVIDER,
      })
      .exec();
    if (existing) return existing;

    return this.conversationModel.create({
      customerUid: customer._id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      providerUid,
      branchId: input.branchId,
      providerType: input.providerType,
      providerName,
      kind: ConversationKind.PROVIDER,
      orderId: input.orderId,
    } as any);
  }

  /**
   * Whether the thread's provider currently holds the Verified badge.
   *
   * Resolved live off the provider document rather than snapshotted onto the
   * thread: a partner who gets verified after a conversation starts should
   * show as verified in it, and an old thread must never contradict the
   * provider's own profile. Derived from `verifiedAt != null`, the same rule
   * discovery uses — never from verificationStatus.
   *
   * Always false for COURIER threads: their provider* fields hold the rider,
   * who has no verification concept.
   */
  async isProviderVerified(convo: Conversation): Promise<boolean> {
    if (convo.kind !== ConversationKind.PROVIDER) return false;
    if (convo.providerType === ProviderType.WASHER) {
      const washer = await this.washerModel
        .findOne({ branchId: convo.branchId })
        .select('verifiedAt')
        .exec();
      return washer?.verifiedAt != null;
    }
    const branch = await this.branchModel
      .findById(convo.branchId)
      .select('verifiedAt')
      .exec();
    return branch?.verifiedAt != null;
  }

  // Find-or-create the customer↔rider thread for one leg of an order. The
  // courier is resolved from the order's leg assignment (pickup vs return), so
  // the pickup rider and the return rider each get their own thread.
  //
  // Either side may open it:
  //  - the customer, at any point once a rider is assigned;
  //  - the assigned rider, but only while they are actually working the leg
  //    (activeCourierLeg: from "Start navigation" until handover). That window
  //    is per leg, so a different rider on the return gets their own thread and
  //    no access to the pickup rider's.
  async startCourierConversation(
    actor: User,
    input: StartCourierConversationInput,
  ): Promise<Conversation> {
    const order = await this.orderModel.findById(input.orderId).exec();
    if (!order) throw new NotFoundException('Order not found');

    const requestedLeg = input.leg === ChatLegType.PICKUP ? 'pickup' : 'return';
    const actorIsCustomer = this.isCustomer(actor);

    if (actorIsCustomer) {
      if (order.customer?.uid !== actor._id) {
        throw new ForbiddenException('This is not your order');
      }
    } else {
      // Rider path: must be the courier on this exact leg, and mid-leg.
      const liveLeg = activeCourierLeg(order, actor._id);
      if (liveLeg !== requestedLeg) {
        throw new ForbiddenException(
          'You can only message the customer while you are on this leg.',
        );
      }
    }

    const assignment =
      input.leg === ChatLegType.PICKUP
        ? order.pickupAssignment
        : order.returnAssignment;
    const courierUid = assignment?.assignedStaffUid;
    if (!courierUid) {
      throw new BadRequestException(
        'No rider is assigned to this leg yet — please try again once a rider is on the way.',
      );
    }

    const customerUid = order.customer.uid;
    // Scoped by legType as well as rider: when the SAME rider works both legs,
    // the return must still open a fresh thread rather than resurrecting the
    // pickup one (which is closed the moment the pickup is handed over).
    const existing = await this.conversationModel
      .findOne({
        customerUid,
        providerUid: courierUid,
        orderId: String(order._id),
        legType: input.leg,
        kind: ConversationKind.COURIER,
      })
      .exec();
    if (existing) return existing;

    const rider = await this.userModel.findById(courierUid).exec();
    const riderName = rider
      ? `${rider.firstName} ${rider.lastName}`.trim()
      : 'Your rider';

    return this.conversationModel.create({
      customerUid,
      customerName: order.customer.displayName,
      providerUid: courierUid,
      providerName: riderName,
      // Carry the underlying provider's type/branch for context; `kind` is what
      // the apps switch on to render this as a rider thread.
      providerType: order.provider.providerType,
      branchId: order.provider.branchId,
      kind: ConversationKind.COURIER,
      legType: input.leg,
      orderId: String(order._id),
    } as any);
  }
}
