import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { InventoryCategory } from '../../inventory/schemas/inventory.schema';

export type ServiceProductDefaultDocument = ServiceProductDefault & Document;

// Which product is the free default for a given (branch, service, category)
// slot — e.g. branch X's "Wash & Fold" includes "Breeze" detergent free.
// The category IS the slot; every other active product this branch stocks
// in the same category is an implicit paid alternative — nothing else needs
// to be enumerated. Reused as-is for Washer (via her anchor branchId) and
// Merchant branches alike, since it just references the shared
// Inventory/Product collections.
@ObjectType()
@Schema({ collection: 'service_product_defaults', timestamps: true })
export class ServiceProductDefault {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  @Field()
  @Prop({ type: String, ref: 'WasherServiceTemplate', required: true })
  serviceTemplateId!: string;

  @Field(() => InventoryCategory)
  @Prop({ type: String, enum: InventoryCategory, required: true })
  category!: InventoryCategory;

  @Field()
  @Prop({ type: String, ref: 'Product', required: true })
  defaultProductId!: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const ServiceProductDefaultSchema = SchemaFactory.createForClass(
  ServiceProductDefault,
);
ServiceProductDefaultSchema.index(
  { branchId: 1, serviceTemplateId: 1, category: 1 },
  { unique: true },
);
