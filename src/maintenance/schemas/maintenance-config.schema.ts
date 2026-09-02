import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// Sub-document, not Mongoose Mixed — so nested Date fields get real BSON
// casting/querying instead of being stored as opaque Mixed data.

export enum MaintenanceType {
  SCHEDULED = 'SCHEDULED',
  EMERGENCY = 'EMERGENCY',
}
registerEnumType(MaintenanceType, { name: 'MaintenanceType' });

// One app's maintenance state. SCHEDULED only blocks while now is inside
// [scheduledStart, scheduledEnd]; EMERGENCY blocks unconditionally the moment
// `active` is true, with no schedule to consult.
//
// `_id: false` is load-bearing, not cosmetic: a single-nested subdocument
// schema that keeps its own auto _id silently drops every other field on
// `$set`/`$setOnInsert` in this Mongoose version — confirmed by isolating it
// in a standalone script (with _id, an update ends up persisting only
// `{ _id: ObjectId(...) }`; without it, the same update persists correctly).
@ObjectType()
@Schema({ _id: false })
export class MaintenanceAppState {
  @Field() @Prop({ type: Boolean, default: false }) active!: boolean;

  // Named `mode`, not `type` — a Mongoose subdocument path literally named
  // `type` collides with Mongoose's own `{ type: String }` schema-definition
  // syntax at the nested level, and silently drops the whole field on write
  // (confirmed: MongoDB itself accepts a raw $set with a `type` key fine,
  // only Mongoose's cast pipeline swallows it).
  @Field(() => MaintenanceType)
  @Prop({
    type: String,
    enum: MaintenanceType,
    default: MaintenanceType.EMERGENCY,
  })
  mode!: MaintenanceType;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  message?: string | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  scheduledStart?: Date | null;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  scheduledEnd?: Date | null;
}

export const MaintenanceAppStateSchema =
  SchemaFactory.createForClass(MaintenanceAppState);

export type MaintenanceConfigDocument = MaintenanceConfig & Document;

// Fixed-key singleton (`_id: 'singleton'`) — one row, upserted in place. No
// version/history: unlike BookingPolicy this has no rollback requirement, and
// keeping a live-toggled switch versioned would only add ceremony to
// something that's meant to be flipped in seconds during an incident.
@ObjectType()
@Schema({ collection: 'maintenance_config', timestamps: true })
export class MaintenanceConfig {
  @Field(() => ID)
  @Prop({ type: String, required: true })
  _id!: string;

  // Master override: when true, BOTH apps are blocked as EMERGENCY with this
  // message regardless of their own individual settings below.
  @Field()
  @Prop({ type: Boolean, default: false })
  globalEmergencyActive!: boolean;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  globalEmergencyMessage?: string | null;

  @Field(() => MaintenanceAppState)
  @Prop({ type: MaintenanceAppStateSchema, default: () => ({}) })
  customerApp!: MaintenanceAppState;

  @Field(() => MaintenanceAppState)
  @Prop({ type: MaintenanceAppStateSchema, default: () => ({}) })
  partnerApp!: MaintenanceAppState;

  /**
   * WHERE TO GO WHEN THE APP WILL NOT OPEN.
   *
   * Its own fields rather than something an admin remembers to type into the
   * message, for two reasons. The message is written in a hurry during an
   * incident, so "contact support@..." is exactly the thing that gets left
   * out of the one screen where it matters most — and free text inside a
   * paragraph is not tappable, so a phone number there is a number somebody
   * has to copy out by hand while their laundry is stuck.
   *
   * Set once, shown on every block, in every app, as a real action.
   */
  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  supportEmail?: string | null;

  @Field(() => String, { nullable: true })
  @Prop({ type: String, default: null })
  supportPhone?: string | null;

  // Accounts (uids) exempt from every block above — for admin/support
  // sign-in-as-a-role testing during an active window. Admin/support roles
  // themselves are never blocked in the first place; this is for a customer
  // or washer test account.
  @Field(() => [String])
  @Prop({ type: [String], default: [] })
  bypassUids!: string[];

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const MaintenanceConfigSchema =
  SchemaFactory.createForClass(MaintenanceConfig);
