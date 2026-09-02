import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';

export enum ProductCategory {
  powdered_detergent = 'powdered_detergent',
  liquid_detergent = 'liquid_detergent',
  fabric_conditioner = 'fabric_conditioner',
  bleach = 'bleach',
  oxybleach = 'oxybleach',
  stain_remover = 'stain_remover',
  dryer_sheet = 'dryer_sheet',
  other = 'other',
}
registerEnumType(ProductCategory, { name: 'ProductCategory' });

export type ProductDocument = Product & Document;

@ObjectType()
@Schema({ collection: 'products', timestamps: true })
export class Product {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Inventory',
    required: true,
  })
  inventoryId!: string;

  @Field()
  @Prop({ required: true, trim: true })
  productName!: string;

  @Field(() => Float)
  @Prop({ required: true })
  price!: number;

  @Field(() => Float)
  @Prop({ required: true })
  quantity!: number;

  @Field(() => InventoryUnit)
  @Prop({ type: String, required: true, enum: InventoryUnit })
  productUnit!: InventoryUnit;

  @Field(() => ProductCategory)
  @Prop({ type: String, required: true, enum: ProductCategory })
  productCategory!: ProductCategory;

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

export const ProductSchema = SchemaFactory.createForClass(Product);
