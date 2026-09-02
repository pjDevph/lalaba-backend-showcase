import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum BroadcastStatus {
  SENDING = 'SENDING',
  SENT = 'SENT',
  /** Nobody in the audience had a device token. Nothing was delivered. */
  NO_RECIPIENTS = 'NO_RECIPIENTS',
  FAILED = 'FAILED',
}
registerEnumType(BroadcastStatus, { name: 'BroadcastStatus' });

export type BroadcastDocument = Broadcast & Document;

/**
 * A record of one message sent to many people.
 *
 * Written BEFORE the send starts and updated after, not created on success:
 * a broadcast that crashed halfway through is the one you most need a record
 * of, and a row that only exists when everything worked cannot tell you who
 * already received it.
 *
 * Append-only in practice — there is no edit path. A message that has reached
 * someone's lock screen cannot be unsent, so "editing" a broadcast would only
 * ever falsify the record of what was actually delivered.
 */
@ObjectType()
@Schema({ collection: 'broadcasts', timestamps: true })
export class Broadcast {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Field()
  @Prop({ type: String, required: true })
  body!: string;

  /** roleIds targeted. Empty is not allowed — see the service. */
  @Field(() => [String])
  @Prop({ type: [String], required: true })
  audienceRoleIds!: string[];

  /** Whether deactivated accounts were included. Almost always false. */
  @Field()
  @Prop({ type: Boolean, default: false })
  includedInactive!: boolean;

  @Field(() => BroadcastStatus)
  @Prop({
    type: String,
    enum: BroadcastStatus,
    default: BroadcastStatus.SENDING,
  })
  status!: BroadcastStatus;

  /** Accounts matching the audience. */
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  audienceCount!: number;

  /**
   * Device tokens actually targeted — always lower than audienceCount, since
   * an account that has never opened the app has no token. Recorded
   * separately so "we told everyone" can be checked rather than assumed.
   */
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  tokenCount!: number;

  /** Tokens FCM rejected as dead. These are pruned from their accounts. */
  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  deadTokenCount!: number;

  @Field()
  @Prop({ type: String, required: true })
  sentByUid!: string;

  /** Denormalised — the record must read correctly after the sender leaves. */
  @Field()
  @Prop({ type: String, required: true })
  sentByName!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  failureReason?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const BroadcastSchema = SchemaFactory.createForClass(Broadcast);
BroadcastSchema.index({ createdAt: -1 });
