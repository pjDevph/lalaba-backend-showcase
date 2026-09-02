import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  DefaultProductPer,
  PricingType,
} from '../../services/schemas/service.schema';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';
import { PosTransaction } from '../../pos_transactions/schemas/pos-transaction.schema';

export enum PaymentStatus {
  UNPAID = 'unpaid',
  PAID = 'paid',
  REFUNDED = 'refunded',
}
registerEnumType(PaymentStatus, { name: 'PaymentStatus' });

export enum LaundryStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  READY = 'ready',
  COMPLETED = 'completed',
  CLAIMED = 'claimed',
  CANCELLED = 'cancelled',
  VOID = 'void',
}
registerEnumType(LaundryStatus, { name: 'LaundryStatus' });

export enum DiscountType {
  flat = 'flat',
  percentage = 'percentage',
}
registerEnumType(DiscountType, { name: 'DiscountType' });

export enum OrderItemType {
  service = 'service',
  product = 'product',
  custom = 'custom',
}
registerEnumType(OrderItemType, { name: 'OrderItemType' });

export enum FulfillmentType {
  PICKUP = 'pickup',
  DELIVERY = 'delivery',
}
registerEnumType(FulfillmentType, { name: 'FulfillmentType' });

@ObjectType()
export class DefaultProductItem {
  @Field() inventoryId!: string;
  @Field() productName!: string;
  @Field(() => Float) quantity!: number;
  @Field() included!: boolean;
  @Field(() => InventoryUnit, { nullable: true }) unit?: InventoryUnit;
  @Field(() => DefaultProductPer, { nullable: true }) per?: DefaultProductPer;
}

@ObjectType()
export class OrderItem {
  @Field(() => OrderItemType) type!: OrderItemType;

  @Field({ nullable: true }) serviceId?: string;
  @Field({ nullable: true }) serviceName?: string;
  @Field({ nullable: true }) serviceCode?: string;
  @Field(() => PricingType, { nullable: true }) pricingType?: PricingType;
  @Field(() => [DefaultProductItem], { nullable: true })
  defaultProducts?: DefaultProductItem[];

  @Field({ nullable: true }) productId?: string;
  @Field({ nullable: true }) productName?: string;

  @Field(() => Float) quantity!: number;
  @Field(() => Float) unitPrice!: number;
  @Field(() => Float) subtotal!: number;
}

export type PosOrderDocument = PosOrder & Document;

@ObjectType()
@Schema({ collection: 'pos_orders', timestamps: true })
export class PosOrder {
  @Field(() => ID) _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  @Field()
  @Prop({ required: true })
  createdBy!: string;

  @Field()
  @Prop({ required: true })
  createdByType!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  customerName?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  customerPhone?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  customerAddress?: string;

  @Field(() => PaymentStatus)
  @Prop({ required: true, enum: PaymentStatus, default: PaymentStatus.UNPAID })
  paymentStatus!: PaymentStatus;

  @Field(() => LaundryStatus)
  @Prop({ required: true, enum: LaundryStatus, default: LaundryStatus.PENDING })
  laundryStatus!: LaundryStatus;

  @Field(() => Float)
  @Prop({ required: true, default: 0 })
  subtotal!: number;

  @Field(() => DiscountType, { nullable: true })
  @Prop({ enum: DiscountType, default: null })
  discountType?: DiscountType;

  @Field(() => Float, { nullable: true })
  @Prop({ default: null })
  discountValue?: number;

  @Field(() => Float)
  @Prop({ default: 0 })
  discount!: number;

  @Field(() => Float)
  @Prop({ required: true, default: 0 })
  totalAmount!: number;

  @Field()
  @Prop({ required: true, unique: true })
  claimCode!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  notes?: string;

  @Field(() => FulfillmentType)
  @Prop({
    type: String,
    enum: FulfillmentType,
    default: FulfillmentType.PICKUP,
  })
  fulfillmentType!: FulfillmentType;

  @Field({ nullable: true })
  @Prop({ default: null })
  idempotencyKey?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  claimedBy?: string;

  @Field(() => [OrderItem])
  @Prop({
    type: [
      {
        type: { type: String, enum: Object.values(OrderItemType) },
        serviceId: String,
        serviceName: String,
        serviceCode: String,
        pricingType: String,
        defaultProducts: [
          {
            inventoryId: String,
            productName: String,
            quantity: Number,
            included: Boolean,
            unit: String,
            per: String,
          },
        ],
        productId: String,
        productName: String,
        quantity: Number,
        unitPrice: Number,
        subtotal: Number,
      },
    ],
    default: [],
  })
  items!: OrderItem[];

  @Field({ nullable: true })
  @Prop({ default: null })
  estimatedReadyAt?: Date;

  @Field({ nullable: true })
  @Prop({ default: null })
  claimedAt?: Date;

  @Field({ nullable: true }) createdAt?: Date;
  @Field({ nullable: true }) updatedAt?: Date;

  @Field(() => [PosTransaction], { nullable: true })
  transactions?: PosTransaction[];
}

export const PosOrderSchema = SchemaFactory.createForClass(PosOrder);
PosOrderSchema.index({ uid: 1, idempotencyKey: 1 }, { sparse: true });
