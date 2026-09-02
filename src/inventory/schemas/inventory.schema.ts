import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum InventoryUnit {
  g = 'g',
  kg = 'kg',
  ml = 'ml',
  L = 'L',
  sachet = 'sachet',
  pieces = 'pieces',
  pack = 'pack',
  box = 'box',
  scoop = 'scoop',
}
registerEnumType(InventoryUnit, { name: 'InventoryUnit' });

export enum InventoryCategory {
  powdered_detergent = 'powdered_detergent',
  liquid_detergent = 'liquid_detergent',
  fabric_conditioner = 'fabric_conditioner',
  bleach = 'bleach',
  oxybleach = 'oxybleach',
  stain_remover = 'stain_remover',
  dryer_sheet = 'dryer_sheet',
  other = 'other',
}
registerEnumType(InventoryCategory, { name: 'InventoryCategory' });

export type InventoryDocument = Inventory & Document;

@ObjectType()
@Schema({ collection: 'inventory', timestamps: true })
export class Inventory {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  @Field()
  @Prop({ required: true, trim: true })
  productName!: string;

  @Field(() => Float)
  @Prop({ required: true })
  cost!: number;

  @Field(() => InventoryUnit)
  @Prop({ required: true, enum: InventoryUnit })
  inventoryUnit!: InventoryUnit;

  @Field(() => InventoryCategory)
  @Prop({ required: true, enum: InventoryCategory })
  inventoryCategory!: InventoryCategory;

  @Field(() => Float)
  @Prop({ required: true, default: 0 })
  stockQuantity!: number;

  @Field(() => Float, { nullable: true })
  @Prop({ default: 0 })
  threshold?: number;

  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  @Field()
  @Prop({ default: false })
  isArchived!: boolean;

  @Field({ nullable: true })
  @Prop({ default: null })
  archivedAt?: Date;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const InventorySchema = SchemaFactory.createForClass(Inventory);
