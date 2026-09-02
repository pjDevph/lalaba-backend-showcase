import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PresenceDocument = Presence & Document;

// Deliberately separate from the User schema/module: presence is a tiny,
// high-write-frequency ping table, and bolting it onto User would mean every
// heartbeat touches a document a lot of other things depend on. No GraphQL
// @ObjectType here — the GraphQL-facing shape is PresenceStatus, a plain
// output type computed by PresenceService.getStatus rather than mirroring
// this raw schema.
@Schema({ collection: 'presence' })
export class Presence {
  @Prop({ type: String, required: true, unique: true, index: true })
  uid!: string;

  @Prop({ type: Date, required: true })
  lastSeenAt!: Date;
}

export const PresenceSchema = SchemaFactory.createForClass(Presence);
