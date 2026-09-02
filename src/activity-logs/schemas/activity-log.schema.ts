import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum ActivityStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}

registerEnumType(ActivityStatus, { name: 'ActivityStatus' });

export type ActivityLogDocument = ActivityLog & Document;

@ObjectType()
@Schema({
  collection: 'activity_logs',
  timestamps: { createdAt: true, updatedAt: false },
})
export class ActivityLog {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ required: true })
  actorId!: string;

  @Field()
  @Prop({ required: true })
  actorName!: string;

  @Field()
  @Prop({ required: true })
  actorEmail!: string;

  @Field()
  @Prop({ required: true })
  actorType!: string;

  @Field()
  @Prop({ required: true })
  merchantId!: string;

  @Field()
  @Prop({ required: true })
  action!: string;

  @Field()
  @Prop({ required: true })
  module!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  targetId?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  targetName?: string;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  metadata?: string;

  @Field(() => ActivityStatus)
  @Prop({ required: true, enum: ActivityStatus })
  status!: ActivityStatus;

  @Field({ nullable: true })
  @Prop({ default: null })
  errorMessage?: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const ActivityLogSchema = SchemaFactory.createForClass(ActivityLog);

ActivityLogSchema.index({ merchantId: 1, createdAt: -1 });
