import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export enum TransactionType {
  RESTOCK = 'RESTOCK',
  CONSUME = 'CONSUME',
  RETURN = 'RETURN',
  ADJUSTMENT = 'ADJUSTMENT',
  DAMAGE = 'DAMAGE',
}
registerEnumType(TransactionType, { name: 'TransactionType' });

export type InventoryTransactionDocument = InventoryTransaction & Document;

@ObjectType()
@Schema({
  collection: 'inventory_transactions',
  timestamps: { createdAt: true, updatedAt: false },
})
export class InventoryTransaction {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Inventory',
    required: true,
  })
  inventoryId!: string;

  @Field(() => TransactionType)
  @Prop({ required: true, enum: TransactionType })
  type!: TransactionType;

  @Field(() => Float)
  @Prop({ required: true })
  quantityChange!: number;

  @Field()
  @Prop({ required: true })
  createdBy!: string;

  @Field()
  @Prop({ required: true })
  createdByType!: string;

  @Field({ nullable: true })
  createdAt?: Date;
}

export const InventoryTransactionSchema =
  SchemaFactory.createForClass(InventoryTransaction);
