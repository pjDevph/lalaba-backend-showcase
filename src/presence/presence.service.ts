import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Presence, PresenceDocument } from './schemas/presence.schema';

// The FE is expected to ping roughly every 20-30s while the app is
// foregrounded, so a 45s window tolerates one missed beat before a viewer
// flips from online to offline.
export const ONLINE_WINDOW_MS = 45_000;

export interface PresenceStatusResult {
  uid: string;
  isOnline: boolean;
  lastSeenAt: Date | null;
}

@Injectable()
export class PresenceService {
  constructor(
    @InjectModel(Presence.name)
    private readonly presenceModel: Model<PresenceDocument>,
  ) {}

  async ping(uid: string): Promise<void> {
    await this.presenceModel
      .findOneAndUpdate(
        { uid },
        { $set: { lastSeenAt: new Date() } },
        { upsert: true },
      )
      .exec();
  }

  async getStatus(uid: string): Promise<PresenceStatusResult> {
    const record = await this.presenceModel.findOne({ uid }).exec();
    const lastSeenAt = record?.lastSeenAt ?? null;
    const isOnline =
      lastSeenAt != null &&
      Date.now() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS;
    return { uid, isOnline, lastSeenAt };
  }
}
