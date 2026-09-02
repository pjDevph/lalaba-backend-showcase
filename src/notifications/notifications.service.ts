import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/schemas/user.schema';
import { NotificationsFeedService } from './notifications-feed.service';
import { NotificationDocument } from './schemas/notification.schema';
import {
  NotificationAudience,
  NotificationCategory,
  NotificationType,
} from './notification.enums';

/** FCM rejects a multicast with more than this many tokens. */
export const FCM_MULTICAST_LIMIT = 500;

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Who a notification is for.
 *
 * A branch target stores ONE row read by the whole branch, and fans out only
 * the pushes. `requiredPermission` narrows both.
 */
export type NotifyTarget =
  { uid: string } | { branchId: string; requiredPermission?: string | null };

export interface NotifyInput {
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, string | null | undefined>;
  deepLink?: string | null;
  /** Idempotency key — see Notification.sourceEventId. */
  sourceEventId?: string | null;
  /** Default true. false pushes without remembering. */
  persist?: boolean;
  /** Default true. false records without pinging. */
  push?: boolean;
  /**
   * Don't push to this account. Almost always the actor: the courier who just
   * tapped "Arrived" does not need telling that they arrived.
   */
  excludeUid?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly firebase: FirebaseService,
    private readonly users: UsersService,
    private readonly feed: NotificationsFeedService,
  ) {}

  /**
   * Best-effort push to every device token a user has registered.
   * NEVER throws — a messaging failure (e.g. a user with no tokens, or bad
   * credentials) must not break the caller (login flows call this). Tokens that
   * FCM reports as unregistered/invalid are pruned so the list stays clean.
   */
  async sendToUser(uid: string, payload: PushPayload): Promise<void> {
    const user = await this.users.findOneById(uid);
    const tokens = (user?.fcmTokens ?? []).filter(Boolean);
    if (!tokens.length) {
      this.logger.log(`No FCM tokens for user ${uid} — skipping push`);
      return;
    }
    const dead = await this.sendToTokens(tokens, payload);
    if (dead.length) await this.users.removeFcmTokens(uid, dead);
    this.logger.log(
      `push to ${uid}: ${tokens.length - dead.length}/${tokens.length} delivered` +
        (dead.length ? ` (${dead.length} dead token(s) pruned)` : ''),
    );
  }

  /**
   * Best-effort push to an EXPLICIT set of device tokens (not resolved from a
   * user). Used to alert the specific device(s) being signed out on a new login,
   * where sending to the whole user would also ping the device that just logged
   * in. NEVER throws. Returns the tokens FCM reported as dead (caller prunes).
   */
  async sendToTokens(
    tokens: string[],
    payload: PushPayload,
  ): Promise<string[]> {
    const clean = tokens.filter(Boolean);
    if (!clean.length) return [];

    // FCM's sendEachForMulticast rejects more than 500 tokens per call. One
    // user never has that many devices, so this was invisible until
    // broadcasts started resolving thousands of recipients into a single
    // list. Chunking here rather than at the call site fixes it for every
    // caller at once.
    if (clean.length > FCM_MULTICAST_LIMIT) {
      const dead: string[] = [];
      for (let i = 0; i < clean.length; i += FCM_MULTICAST_LIMIT) {
        dead.push(
          ...(await this.sendToTokens(
            clean.slice(i, i + FCM_MULTICAST_LIMIT),
            payload,
          )),
        );
      }
      return dead;
    }

    try {
      const res = await this.firebase.getMessaging().sendEachForMulticast({
        tokens: clean,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });

      const dead: string[] = [];
      res.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code ?? 'unknown';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-argument') ||
          code.includes('invalid-registration-token')
        ) {
          dead.push(clean[i]);
        }
        this.logger.warn(`push to ${clean[i].slice(0, 12)}… failed: ${code}`);
      });
      return dead;
    } catch (err) {
      // Non-fatal on purpose — e.g. credential/network issues.
      this.logger.error(`push errored: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Persist a feed row AND fire the push. This is the API every sender should
   * use; sendToUser/sendToTokens remain for the rare push that must NOT be
   * remembered (see DEVICE_SUPERSEDED in devices.service.ts).
   *
   * Persist first, push second, and deliberately so: a push that fails is a
   * lost ping the user can still find in their inbox, whereas a row that fails
   * to persist is history that never existed. Ordering it the other way would
   * make the cheap failure destroy the durable record.
   *
   * NEVER throws — callers are decision paths (a KYC approval, an order
   * transition) whose work is already committed and must not be rolled back by
   * a messaging problem.
   */
  async notify(target: NotifyTarget, input: NotifyInput): Promise<void> {
    try {
      const isBranch = 'branchId' in target;
      const requiredPermission = isBranch
        ? (target.requiredPermission ?? null)
        : null;

      let row: NotificationDocument | null = null;
      if (input.persist !== false) {
        row = await this.feed.persist({
          audience: isBranch
            ? NotificationAudience.BRANCH
            : NotificationAudience.USER,
          uid: isBranch ? null : target.uid,
          branchId: isBranch ? target.branchId : null,
          merchantId: isBranch
            ? await this.feed.ownerUidOf(target.branchId)
            : null,
          requiredPermission,
          type: input.type,
          category: input.category,
          title: input.title,
          body: input.body,
          data: input.data,
          deepLink: input.deepLink ?? null,
          sourceEventId: input.sourceEventId ?? null,
        });

        // A duplicate sourceEventId means this event was already reported.
        // Skipping the push too is what makes the order sweeper safe to retry.
        if (!row && input.sourceEventId) return;
      }

      if (input.push === false) return;

      const payload: PushPayload = {
        title: input.title,
        body: input.body,
        data: this.toPushData(input),
      };

      const recipients = isBranch
        ? await this.feed.branchPushRecipients(
            target.branchId,
            requiredPermission,
            input.excludeUid,
          )
        : [target.uid].filter((uid) => uid !== input.excludeUid);

      for (const uid of recipients) {
        await this.sendToUser(uid, payload);
      }
      if (row) await this.feed.markPushed(String(row._id));
    } catch (err) {
      this.logger.error(`notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * FCM data values must all be strings — a number or null silently breaks the
   * whole message rather than the one field.
   */
  private toPushData(input: NotifyInput): Record<string, string> {
    const out: Record<string, string> = { type: String(input.type) };
    if (input.deepLink) out.deepLink = input.deepLink;
    for (const [k, v] of Object.entries(input.data ?? {})) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }

  /**
   * Notify a staff member's owner/merchant that the staff just signed in.
   * A no-op for non-staff users (only staff carry a merchantId).
   */
  async notifyOwnerOfStaffLogin(staff: User): Promise<void> {
    if (!staff.merchantId) return;
    const name =
      [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim() ||
      'A staff member';
    await this.notify(
      { uid: staff.merchantId },
      {
        type: NotificationType.STAFF_LOGIN,
        category: NotificationCategory.STAFF,
        title: 'Staff signed in',
        body: `${name} just signed in.`,
        data: { staffId: String(staff._id) },
      },
    );
  }
}
