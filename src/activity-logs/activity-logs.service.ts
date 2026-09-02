import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ActivityLog,
  ActivityLogDocument,
  ActivityStatus,
} from './schemas/activity-log.schema';
import { ActivityLogFilterInput } from './dto/activity-log-filter.input';
import { PaginatedActivityLogs } from './models/paginated-activity-logs.model';
import { escapeRegex } from '../common/utils/escape-regex.util';

export interface RecordActivityData {
  actorId: string;
  actorName: string;
  actorEmail: string;
  actorType: string;
  merchantId: string;
  action: string;
  module: string;
  targetId?: string;
  targetName?: string;
  metadata?: string;
  status: ActivityStatus;
  errorMessage?: string;
}

@Injectable()
export class ActivityLogsService {
  private readonly logger = new Logger(ActivityLogsService.name);

  constructor(
    @InjectModel(ActivityLog.name)
    private readonly activityLogModel: Model<ActivityLogDocument>,
  ) {}

  async record(data: RecordActivityData): Promise<void> {
    try {
      await this.activityLogModel.create(data);
    } catch (err) {
      this.logger.error('Failed to write activity log', (err as Error)?.stack);
    }
  }

  async findAll(
    merchantId: string,
    filter: ActivityLogFilterInput = {},
  ): Promise<PaginatedActivityLogs> {
    const {
      actorId,
      action,
      module,
      status,
      dateFrom,
      dateTo,
      limit = 10,
      offset = 0,
    } = filter;

    const query: Record<string, any> = { merchantId };

    if (actorId) query.actorId = actorId;
    // Escaped: this is caller-supplied text going into a regex. Unescaped, a
    // filter of '(a+)+$' is a ReDoS against the log query, and '.*' quietly
    // widens the match. Length caps do not help here — escaping does.
    if (action) {
      query.action = { $regex: escapeRegex(action), $options: 'i' };
    }
    if (module) query.module = module;
    if (status) query.status = status;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = dateFrom;
      if (dateTo) query.createdAt.$lte = dateTo;
    }

    const [data, total] = await Promise.all([
      this.activityLogModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .exec(),
      this.activityLogModel.countDocuments(query).exec(),
    ]);

    return { data, total, limit, offset };
  }
}
