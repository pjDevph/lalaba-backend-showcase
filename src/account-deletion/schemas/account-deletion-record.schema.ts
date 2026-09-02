import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AccountDeletionRecordDocument = AccountDeletionRecord & Document;

// Audit trail for the deletion lifecycle. Deliberately holds NO PII beyond the
// uid/roleId — it exists to prove when each step ran, which is exactly the
// record that must survive the erasure it documents.
@Schema({ collection: 'account_deletion_records', timestamps: true })
export class AccountDeletionRecord {
  @Prop({ type: String, ref: 'User', required: true, index: true })
  uid!: string;

  @Prop({ type: String, default: null })
  roleId?: string;

  @Prop({ type: Date, required: true })
  requestedAt!: Date;

  /** End of the grace period — the earliest the erasure may run. */
  @Prop({ type: Date, required: true })
  scheduledAt!: Date;

  @Prop({ type: Date, default: null })
  cancelledAt?: Date;

  @Prop({ type: String, default: null })
  cancelledBy?: string;

  @Prop({ type: Date, default: null })
  completedAt?: Date;

  /** Per-step outcome of the erasure pass — counts, not contents. */
  @Prop({
    type: {
      userAnonymized: { type: Boolean, default: false },
      devicesRemoved: { type: Number, default: 0 },
      firebaseIdentityDeleted: { type: Boolean, default: false },
      washerProfileScrubbed: { type: Boolean, default: false },
      activityLogsRedacted: { type: Number, default: 0 },
      onlineOrderSnapshotsRedacted: { type: Number, default: 0 },
      legacyBookingContactRedacted: { type: Number, default: 0 },
    },
    default: () => ({}),
  })
  processingSummary?: {
    userAnonymized: boolean;
    devicesRemoved: number;
    firebaseIdentityDeleted: boolean;
    washerProfileScrubbed: boolean;
    activityLogsRedacted: number;
    onlineOrderSnapshotsRedacted: number;
    legacyBookingContactRedacted: number;
  };

  createdAt?: Date;
  updatedAt?: Date;
}

export const AccountDeletionRecordSchema = SchemaFactory.createForClass(
  AccountDeletionRecord,
);

AccountDeletionRecordSchema.index({ uid: 1, completedAt: 1, cancelledAt: 1 });
