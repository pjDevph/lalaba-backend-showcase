import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  AdminAuditAction,
  AdminAuditEvent,
  AdminAuditEventDocument,
  AdminAuditTargetType,
} from './schemas/admin-audit-event.schema';
import { AdminAuditFilterInput } from './dto/admin-audit-filter.input';
import { PaginatedAdminAuditEvents } from './models/paginated-admin-audit.model';
import { User } from '../users/schemas/user.schema';

/** What a caller must supply to record one action. */
export interface RecordAdminActionInput {
  action: AdminAuditAction;
  actor: Pick<User, '_id' | 'firstName' | 'lastName' | 'email' | 'role'>;
  targetType: AdminAuditTargetType;
  targetId: string;
  targetLabel?: string | null;
  reasonCode?: string | null;
  note?: string | null;
  details?: Record<string, unknown> | null;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @InjectModel(AdminAuditEvent.name)
    private readonly auditModel: Model<AdminAuditEventDocument>,
  ) {}

  /**
   * Append one action to the trail.
   *
   * NEVER THROWS. A failed audit write must not roll back the action it
   * describes: a suspension that half-succeeded — provider suspended, no
   * record, caller sees an error — is worse than a suspension with a missing
   * log line, because the operator will retry it and the state is already
   * changed. Failures are logged loudly instead.
   *
   * The corollary is that callers must record AFTER the action succeeds, not
   * before, or the trail will claim things that never happened.
   */
  async record(input: RecordAdminActionInput): Promise<void> {
    try {
      await this.auditModel.create({
        action: input.action,
        actorUid: String(input.actor._id),
        // Denormalised: the trail has to still read correctly once the actor
        // is renamed or removed.
        actorName:
          `${input.actor.firstName ?? ''} ${input.actor.lastName ?? ''}`.trim() ||
          String(input.actor._id),
        actorEmail: input.actor.email ?? '',
        actorRole: this.roleIdOf(input.actor),
        targetType: input.targetType,
        targetId: input.targetId,
        // `undefined`, not `null`: these props are declared optional and
        // carry `default: null` in the schema, so letting Mongoose apply the
        // default is both type-correct and stores the same value.
        targetLabel: input.targetLabel ?? undefined,
        reasonCode: input.reasonCode ?? undefined,
        note: input.note?.trim() || undefined,
        details: input.details ?? undefined,
      });
    } catch (err) {
      this.logger.error(
        `Failed to write admin audit event ${input.action} on ${input.targetType}:${input.targetId}`,
        (err as Error)?.stack,
      );
    }
  }

  /**
   * `role` is a populated document on some read paths and a bare ObjectId
   * string on others, depending on how the caller loaded the user.
   */
  private roleIdOf(actor: RecordAdminActionInput['actor']): string {
    const role = actor.role as unknown;
    if (role && typeof role === 'object' && 'roleId' in role) {
      return String((role as { roleId: string }).roleId);
    }
    // Only a primitive is meaningful here. An object without `roleId` would
    // stringify to '[object Object]' and put noise in the trail — 'unknown'
    // at least reads as "we could not tell", which is the truth.
    if (typeof role === 'string' || typeof role === 'number') {
      return String(role);
    }
    return 'unknown';
  }

  async find(
    filter: AdminAuditFilterInput = {},
  ): Promise<PaginatedAdminAuditEvents> {
    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;

    const query: Record<string, unknown> = {};
    if (filter.actions?.length) query.action = { $in: filter.actions };
    if (filter.actorUid) query.actorUid = filter.actorUid;
    if (filter.targetType) query.targetType = filter.targetType;
    if (filter.targetId) query.targetId = filter.targetId;
    if (filter.dateFrom || filter.dateTo) {
      const range: Record<string, Date> = {};
      if (filter.dateFrom) range.$gte = new Date(filter.dateFrom);
      if (filter.dateTo) range.$lte = new Date(filter.dateTo);
      query.timestamp = range;
    }

    const [data, total] = await Promise.all([
      this.auditModel
        .find(query)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.auditModel.countDocuments(query).exec(),
    ]);

    return { data, total, limit, offset };
  }
}
