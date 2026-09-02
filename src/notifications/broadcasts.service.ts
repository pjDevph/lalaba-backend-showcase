import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { NotificationsService } from './notifications.service';
import {
  Broadcast,
  BroadcastDocument,
  BroadcastStatus,
} from './schemas/broadcast.schema';
import { SendBroadcastInput } from './dto/send-broadcast.input';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Role, RoleDocument } from '../users/schemas/role.schema';
import { BroadcastPreview } from './models/broadcast-preview.model';

/**
 * Sending one message to many people.
 *
 * The whole design assumption here is that a broadcast is IRREVERSIBLE. A push
 * that has reached someone's lock screen cannot be recalled, so everything
 * below is arranged around letting an admin find out what they are about to do
 * BEFORE they do it, and around leaving an accurate record afterwards.
 */
@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    @InjectModel(Broadcast.name)
    private readonly broadcastModel: Model<BroadcastDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name)
    private readonly roleModel: Model<RoleDocument>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * How many people this would reach, without sending anything.
   *
   * The point of the panel calling this first: `audienceCount` and
   * `reachableCount` are usually very different numbers, because an account
   * that has never opened the app has no device token. An admin who thinks
   * "customers" means 4,000 people should see that only 1,200 of them can
   * actually be reached before they decide the wording.
   */
  async preview(
    roleIds: string[],
    includeInactive = false,
  ): Promise<BroadcastPreview> {
    const uids = await this.audienceUids(roleIds, includeInactive);
    const tokens = await this.tokensFor(uids);
    return {
      audienceCount: uids.length,
      reachableCount: tokens.userCount,
      tokenCount: tokens.tokens.length,
    };
  }

  async send(input: SendBroadcastInput, actor: User): Promise<Broadcast> {
    if (!input.audienceRoleIds?.length) {
      // Belt and braces with the DTO's ArrayNotEmpty: an empty audience must
      // never be interpreted as "everyone".
      throw new BadRequestException('Pick at least one audience');
    }

    const uids = await this.audienceUids(
      input.audienceRoleIds,
      input.includeInactive ?? false,
    );
    const { tokens } = await this.tokensFor(uids);

    // The record is written BEFORE the send. A broadcast that crashes halfway
    // is the one you most need a record of, and a row created only on success
    // cannot tell you who already received it.
    const broadcast = await this.broadcastModel.create({
      title: input.title,
      body: input.body,
      audienceRoleIds: input.audienceRoleIds,
      includedInactive: input.includeInactive ?? false,
      status: BroadcastStatus.SENDING,
      audienceCount: uids.length,
      tokenCount: tokens.length,
      sentByUid: String(actor._id),
      sentByName:
        `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() ||
        actor.email ||
        String(actor._id),
    });

    if (tokens.length === 0) {
      // Not a failure — the audience simply has no reachable devices. Saying
      // so plainly stops someone re-sending the same message four times
      // wondering why nothing arrived.
      broadcast.status = BroadcastStatus.NO_RECIPIENTS;
      await broadcast.save();
      return broadcast;
    }

    try {
      // sendToTokens chunks to FCM's 500-token limit internally and never
      // throws for individual failures; it returns the tokens FCM reported as
      // dead so they can be pruned.
      const dead = await this.notifications.sendToTokens(tokens, {
        title: input.title,
        body: input.body,
        data: { type: 'BROADCAST', broadcastId: String(broadcast._id) },
      });

      await this.pruneDeadTokens(dead);

      broadcast.status = BroadcastStatus.SENT;
      broadcast.deadTokenCount = dead.length;
      await broadcast.save();
      this.logger.log(
        `broadcast ${String(broadcast._id)}: ${tokens.length - dead.length}/${tokens.length} delivered`,
      );
    } catch (err) {
      // sendToTokens swallows its own errors, so reaching here means something
      // structural. Record it rather than losing the fact that a send was
      // attempted at all.
      broadcast.status = BroadcastStatus.FAILED;
      broadcast.failureReason = (err as Error)?.message ?? 'Unknown error';
      await broadcast.save();
      this.logger.error(
        `broadcast ${String(broadcast._id)} failed`,
        (err as Error)?.stack,
      );
    }

    return broadcast;
  }

  async history(limit = 25, offset = 0) {
    const [data, total] = await Promise.all([
      this.broadcastModel
        .find()
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.broadcastModel.countDocuments().exec(),
    ]);
    return { data, total, limit, offset };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async audienceUids(
    roleIds: string[],
    includeInactive: boolean,
  ): Promise<string[]> {
    const roles = await this.roleModel
      .find({ roleId: { $in: roleIds } })
      .select('_id')
      .exec();

    // An unrecognised roleId must resolve to nobody rather than being dropped
    // from the query — dropping it would widen the send to every account on
    // the platform, which is the worst possible failure mode here.
    if (roles.length === 0) return [];

    const query: Record<string, unknown> = {
      role: { $in: roles.map((r) => r._id) },
    };
    if (!includeInactive) query.isActive = true;

    const users = await this.userModel.find(query).select('_id').exec();
    return users.map((u) => String(u._id));
  }

  /**
   * Device tokens for a set of accounts.
   *
   * `userCount` counts accounts that have at least one token — the honest
   * answer to "how many people will actually see this", which is never the
   * same as the number of tokens.
   */
  private async tokensFor(
    uids: string[],
  ): Promise<{ tokens: string[]; userCount: number }> {
    if (uids.length === 0) return { tokens: [], userCount: 0 };

    const users = await this.userModel
      // Cast: User._id is a Firebase uid stored as a String, but the hydrated
      // document type intersects it with ObjectId. Same mismatch worked around
      // in the directory and order search.
      .find({
        _id: { $in: uids as unknown as UserDocument['_id'][] },
        fcmTokens: { $exists: true, $ne: [] },
      })
      .select('fcmTokens')
      .exec();

    const tokens = users.flatMap((u) => (u.fcmTokens ?? []).filter(Boolean));
    // De-duplicated: the same device can end up on two accounts after a
    // shared-phone signup, and sending twice would look like a bug to whoever
    // is holding it.
    return { tokens: [...new Set(tokens)], userCount: users.length };
  }

  /** Remove tokens FCM rejected, so the next broadcast's numbers stay honest. */
  private async pruneDeadTokens(dead: string[]): Promise<void> {
    if (!dead.length) return;
    await this.userModel
      .updateMany(
        { fcmTokens: { $in: dead } },
        { $pull: { fcmTokens: { $in: dead } } },
      )
      .exec();
  }
}
