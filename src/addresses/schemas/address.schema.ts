import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import {
  BranchAddress,
  BranchAddressSchema,
  MapLocation,
  MapLocationSchema,
} from '../../branches/schemas/sub-documents.schema';

export type AddressDocument = Address & Document;

// Customer-owned saved address. Reuses the same BranchAddress/MapLocation
// shape Branch and WasherProfile use, per the shared address decision — no
// bespoke address format for Customer.
@ObjectType()
@Schema({ collection: 'addresses', timestamps: true })
export class Address {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true })
  label?: string; // e.g. "Home", "Work"

  @Field(() => BranchAddress)
  @Prop({ type: BranchAddressSchema, required: true })
  address!: BranchAddress;

  @Field(() => MapLocation)
  @Prop({ type: MapLocationSchema, required: true })
  mapLocation!: MapLocation;

  @Field({ nullable: true })
  @Prop({ type: String, default: null, trim: true })
  accessInstructions?: string; // gate/floor/landmark notes for pickup/delivery

  @Field()
  @Prop({ default: false })
  isDefault!: boolean;

  @Field()
  @Prop({ default: false })
  isArchived!: boolean;

  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  archivedAt?: Date;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const AddressSchema = SchemaFactory.createForClass(Address);
AddressSchema.index({ uid: 1, isArchived: 1, createdAt: -1 });
// At most one active default address per customer.
AddressSchema.index(
  { uid: 1, isDefault: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefault: true, isArchived: false },
  },
);
