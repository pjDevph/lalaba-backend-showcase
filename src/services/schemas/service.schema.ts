import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { InventoryUnit } from '../../inventory/schemas/inventory.schema';

export enum DefaultProductPer {
  order = 'order',
  kg = 'kg',
  load = 'load',
  pc = 'pc',
}
registerEnumType(DefaultProductPer, { name: 'DefaultProductPer' });

export enum PricingType {
  PER_KILO = 'per_kilo',
  PER_PIECE = 'per_piece',
  /** One flat charge for the line, however much it weighs. */
  PER_LOAD = 'per_load',
  PER_KILO_WITH_BASE = 'per_kilo_with_base',
  /**
   * Machine-load pricing: the weight is divided by the provider's load
   * capacity and rounded UP, then charged per load. A home washer with a 7 kg
   * machine quoting ₱180 charges ₱360 for 10 kg (two loads).
   *
   * Deliberately separate from PER_LOAD rather than a redefinition of it —
   * PER_LOAD is live on merchant services and means one flat charge, so
   * changing its meaning would silently re-price every one of them.
   */
  PER_LOAD_WITH_CAPACITY = 'per_load_with_capacity',
}
registerEnumType(PricingType, { name: 'PricingType' });

export enum ServiceCategory {
  WASH_AND_FOLD = 'wash_and_fold',
  WASH_AND_IRON = 'wash_and_iron',
  WASH_ONLY = 'wash_only',
  DRY_CLEAN = 'dry_clean',
  IRON_ONLY = 'iron_only',
  EXPRESS = 'express',
  DELICATE = 'delicate',
  BEDDING = 'bedding',
  CURTAINS = 'curtains',
  SHOES = 'shoes',
  BAGS = 'bags',
  OTHER = 'other',
}
registerEnumType(ServiceCategory, { name: 'ServiceCategory' });

@ObjectType()
export class DefaultProduct {
  @Field() inventoryId!: string;
  @Field() productName!: string;
  @Field(() => Float) quantity!: number;
  @Field(() => InventoryUnit, { nullable: true }) unit?: InventoryUnit;
  @Field(() => DefaultProductPer, { nullable: true }) per?: DefaultProductPer;
}

export type ServiceDocument = Service & Document;

@ObjectType()
@Schema({ collection: 'services', timestamps: true })
export class Service {
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
  serviceName!: string;

  @Field({ nullable: true })
  @Prop({ default: null, trim: true, uppercase: true })
  serviceCode?: string;

  @Field(() => Float)
  @Prop({ required: true })
  price!: number;

  @Field(() => PricingType)
  @Prop({ required: true, enum: PricingType })
  pricingType!: PricingType;

  @Field(() => Float, { nullable: true })
  @Prop({ default: null })
  baseKilos?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ default: null })
  excessRate?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ default: null })
  suppliesCost?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ default: null })
  estimatedMinutes?: number;

  @Field(() => ServiceCategory)
  @Prop({ required: true, enum: ServiceCategory })
  category!: ServiceCategory;

  @Field(() => [DefaultProduct], { nullable: true })
  @Prop({
    type: [
      {
        inventoryId: String,
        productName: String,
        quantity: Number,
        unit: String,
        per: String,
      },
    ],
    default: [],
  })
  defaultProducts?: DefaultProduct[];

  @Field()
  @Prop({ default: false })
  requiresWeighing!: boolean;

  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  // Catalog visibility: whether this service is bookable through the online
  // marketplace, independent of isActive (which POS also reads). Branch-level
  // Branch.isOnline is the outer gate — this is the per-service one inside it,
  // so a shop can keep a walk-in-only service off discovery without pulling
  // it from POS.
  @Field()
  @Prop({ default: true })
  isOnline!: boolean;

  // Purely a catalog-ordering hint (top of the service list) — no pricing or
  // eligibility meaning, unlike isOnline above.
  @Field()
  @Prop({ default: false })
  isFeatured!: boolean;

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

export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.index(
  { branchId: 1, serviceCode: 1 },
  {
    unique: true,
    partialFilterExpression: { serviceCode: { $type: 'string' } },
  },
);
// Case-insensitive uniqueness guard on top of the app-level check in
// ServicesService — protects against concurrent create/update races.
ServiceSchema.index(
  { branchId: 1, serviceName: 1 },
  {
    unique: true,
    partialFilterExpression: { isArchived: false },
    collation: { locale: 'en', strength: 2 },
  },
);
