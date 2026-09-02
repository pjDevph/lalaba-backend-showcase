import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Lifecycle of a device registration:
//   PENDING  — staff registered it; waiting for the owner to approve.
//   APPROVED — owner approved; the device may be used to sign in (auth gate).
//   BLOCKED  — owner blocked it; sign-in is refused (staff auto-logs out).
// Owner-registered devices are created APPROVED immediately.
export enum DeviceStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  BLOCKED = 'BLOCKED',
}
registerEnumType(DeviceStatus, { name: 'DeviceStatus' });

export type DeviceDocument = Device & Document;

@ObjectType()
@Schema({ timestamps: true })
export class Device {
  @Field(() => ID)
  _id!: string;

  // Merchant grouping key — the owner's uid. All of a merchant's devices (owner
  // + staff) live under this uid, matching the existing auth/lookup model.
  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  // The staff member who registered/uses this device (for owner devices, the
  // owner). staffName is denormalized so the owner's list needs no extra lookup.
  @Field({ nullable: true })
  @Prop({ type: String, ref: 'User', default: null })
  staffUid?: string;

  @Field({ nullable: true })
  @Prop({ default: '' })
  staffName?: string;

  // The branch this device is registered to (staff picks it at registration).
  @Field({ nullable: true })
  @Prop({ type: String, ref: 'Branch', default: null })
  branchId?: string;

  @Field()
  @Prop({ required: true, trim: true })
  deviceName!: string;

  @Field()
  @Prop({ required: true, trim: true })
  operatingSystem!: string;

  // Marketing model, e.g. "iPhone 14", "Pixel 7" (captured client-side).
  @Field({ nullable: true })
  @Prop({ default: '' })
  deviceModel?: string;

  @Field()
  @Prop({ required: true })
  fcmToken!: string;

  @Field(() => DeviceStatus)
  @Prop({ type: String, enum: DeviceStatus, default: DeviceStatus.PENDING })
  status!: DeviceStatus;

  // Kept in sync with status (APPROVED => true) for backward compatibility with
  // existing reads; status is the source of truth for authorization.
  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  // Single-active-device control (STAFF only): the one APPROVED device currently
  // holding this staff account's session. Logging in on another device sets that
  // device's flag true and flips every sibling to false — a superseded device
  // then fails the auth gate on its next request and auto-signs-out. Owners are
  // exempt (their requests are not device-gated, so they may use many devices).
  @Field()
  @Prop({ default: true })
  activeSession!: boolean;

  // The real FCM push token last registered from this device — distinct from
  // `fcmToken`, which is the stable device UUID. Lets us prune a superseded
  // device's push token so it stops receiving this account's notifications.
  // Not exposed over GraphQL (no @Field) — push tokens must not leak to clients.
  @Prop({ default: '' })
  pushToken?: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const DeviceSchema = SchemaFactory.createForClass(Device);

// One registration per physical device (fcmToken) per merchant.
DeviceSchema.index({ uid: 1, fcmToken: 1 }, { unique: true });
