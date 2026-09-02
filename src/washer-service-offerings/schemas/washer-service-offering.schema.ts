import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  WasherPricingModel,
  WasherServiceUnit,
} from '../../washer-service-templates/schemas/washer-service-template.schema';

export type WasherServiceOfferingDocument = WasherServiceOffering & Document;

/**
 * One washer's own pricing for one platform service.
 *
 * The template says WHAT the service is and which charging methods are legal;
 * this row says what THIS washer charges for it. Two washers can offer the
 * same "Wash & Fold" as ₱38/kg and ₱180 per 7 kg load respectively.
 *
 * Deliberately an OVERRIDE, not a replacement: `offeredServiceTemplateIds` on
 * the profile remains the on/off switch, and a washer with no offering row is
 * priced from the template's own numbers. That is what lets this ship without
 * a migration — every existing washer keeps the exact price she has today
 * until she opens the editor.
 *
 * Keyed by branchId + serviceTemplateId, mirroring ServiceProductDefault:
 * branchId is the id orders and discovery already resolve a washer by.
 */
@ObjectType()
@Schema({ collection: 'washer_service_offerings', timestamps: true })
export class WasherServiceOffering {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true, index: true })
  branchId!: string;

  @Field()
  @Prop({ type: String, ref: 'WasherServiceTemplate', required: true })
  serviceTemplateId!: string;

  @Field(() => WasherPricingModel)
  @Prop({ type: String, enum: WasherPricingModel, required: true })
  pricingModel!: WasherPricingModel;

  /**
   * The headline amount in centavos — per kg, per load, or the base price,
   * depending on `pricingModel`. This is what the guardrails bound.
   */
  @Field(() => Float)
  @Prop({ required: true, min: 0 })
  priceCentavos!: number;

  /**
   * PER_LOAD: how much laundry fits in one machine run. The washer sets this,
   * not the platform — a 6.5 kg machine and a 12 kg machine are both normal
   * for a home washer, and one platform-wide "load" would misprice both.
   */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  loadCapacityKg?: number | null;

  /** BASE_EXCESS: kilos covered by `priceCentavos`. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  baseWeightKg?: number | null;

  /** BASE_EXCESS: charged per kilo above `baseWeightKg`. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  excessRatePerKgCentavos?: number | null;

  /** PER_KG / BASE_EXCESS: smallest weight billed, so tiny jobs stay viable. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  minBillableKg?: number | null;

  /** PER_ITEM: what `priceCentavos` buys one of. */
  @Field(() => WasherServiceUnit, { nullable: true })
  @Prop({ type: String, enum: WasherServiceUnit, default: null })
  unit?: WasherServiceUnit | null;

  /**
   * PER_ITEM: the smallest order she will take. A single ₱120 curtain panel
   * is not worth a pickup trip, so she can require two.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 1 })
  minQuantity?: number | null;

  /**
   * PER_ITEM: the most she will handle in one order — a capacity limit, not a
   * price one. Null means no ceiling.
   */
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: null, min: 1 })
  maxQuantity?: number | null;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WasherServiceOfferingSchema = SchemaFactory.createForClass(
  WasherServiceOffering,
);

// One offering per (branch, service). setWasherServiceOffering upserts on it.
WasherServiceOfferingSchema.index(
  { branchId: 1, serviceTemplateId: 1 },
  { unique: true },
);
