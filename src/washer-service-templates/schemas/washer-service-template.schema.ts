import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { PricingType } from '../../services/schemas/service.schema';

export type WasherServiceTemplateDocument = WasherServiceTemplate & Document;

/**
 * Who decides what a washer charges for this service.
 *
 * Home washers do not share a cost structure — machine capacity, utilities and
 * neighbourhood rates all differ — so the platform defines WHICH services
 * exist and HOW they may be charged, and (by default) the washer sets the
 * amount. PLATFORM_FIXED preserves the original behaviour for any service
 * Lalaba wants to price itself.
 */
export enum WasherPricingControl {
  /** Lalaba sets the price; the washer only chooses to offer it or not. */
  PLATFORM_FIXED = 'platform_fixed',
  /** The washer sets her own price, within the guardrails below. */
  WASHER_SET = 'washer_set',
}
registerEnumType(WasherPricingControl, { name: 'WasherPricingControl' });

/**
 * The charging methods a washer may pick from for this service. These are the
 * washer-facing vocabulary; each maps onto exactly one shared `PricingType`
 * (see PRICING_MODEL_TO_TYPE below) so orders, quotes and the customer app all
 * run through the one formula in online-orders/pricing.util.ts.
 */
export enum WasherPricingModel {
  /** ₱X per kilo, with an optional minimum billable weight. */
  PER_KG = 'per_kg',
  /** ₱X per machine load, weight divided by capacity and rounded up. */
  PER_LOAD = 'per_load',
  /** ₱X covers the first N kg, then ₱Y per excess kg. */
  BASE_EXCESS = 'base_excess',
  /**
   * ₱X per physical item, counted rather than weighed. Comforters, curtains
   * and shoes have no sensible price per kilo — a duvet is bulky and light,
   * and billing it by weight underprices the machine time it monopolises.
   */
  PER_ITEM = 'per_item',
}
registerEnumType(WasherPricingModel, { name: 'WasherPricingModel' });

/**
 * What a PER_ITEM service counts. Platform-controlled rather than free text:
 * "pair", "Pair", "pairs" and "per pair" are the same unit to a washer and
 * four different strings to a customer scanning a price list.
 */
export enum WasherServiceUnit {
  PIECE = 'piece',
  PAIR = 'pair',
  SET = 'set',
  PANEL = 'panel',
}
registerEnumType(WasherServiceUnit, { name: 'WasherServiceUnit' });

export const PRICING_MODEL_TO_TYPE: Record<WasherPricingModel, PricingType> = {
  [WasherPricingModel.PER_KG]: PricingType.PER_KILO,
  [WasherPricingModel.PER_LOAD]: PricingType.PER_LOAD_WITH_CAPACITY,
  [WasherPricingModel.BASE_EXCESS]: PricingType.PER_KILO_WITH_BASE,
  [WasherPricingModel.PER_ITEM]: PricingType.PER_PIECE,
};

/** True for models billed by counted items rather than measured weight. */
export function isCountedModel(model: WasherPricingModel): boolean {
  return model === WasherPricingModel.PER_ITEM;
}

/**
 * The default allow-list for a new template — deliberately NOT every model.
 *
 * This constant is also the fallback for templates saved before a model
 * existed, so adding PER_ITEM here would retroactively let washers price
 * Wash & Fold per piece on every template already in the database. Per-item
 * is opt-in: an admin ticks it on the services where counting makes sense.
 */
export const ALL_PRICING_MODELS: WasherPricingModel[] = [
  WasherPricingModel.PER_KG,
  WasherPricingModel.PER_LOAD,
  WasherPricingModel.BASE_EXCESS,
];

/** Every model, for admin-facing pickers that must offer the full set. */
export const EVERY_PRICING_MODEL: WasherPricingModel[] = [
  ...ALL_PRICING_MODELS,
  WasherPricingModel.PER_ITEM,
];

// The platform's catalog of home-washer services. Lalaba controls which
// services exist, which charging methods are allowed, and the safety limits
// around the amount; the washer controls the amount itself (see
// washer-service-offerings). Merchant branch services are a separate,
// fully self-configured model — this catalog does not apply to them.
@ObjectType()
@Schema({ collection: 'washer_service_templates', timestamps: true })
export class WasherServiceTemplate {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ required: true, trim: true, unique: true })
  name!: string; // e.g. "Wash & Fold"

  @Field({ nullable: true })
  @Prop({ type: String, default: null })
  description?: string;

  // ── Pricing policy ───────────────────────────────────────────────────────

  @Field(() => WasherPricingControl)
  @Prop({
    type: String,
    enum: WasherPricingControl,
    default: WasherPricingControl.WASHER_SET,
  })
  pricingControl!: WasherPricingControl;

  @Field(() => [WasherPricingModel])
  @Prop({
    type: [String],
    enum: WasherPricingModel,
    default: ALL_PRICING_MODELS,
  })
  allowedPricingModels!: WasherPricingModel[];

  // Guardrails, not a market price: broad limits that stop a fat-fingered
  // ₱0.01/kg or ₱999,999/load from reaching customers. Null = unbounded.
  // Compared against the washer's headline amount (per kg, per load, or the
  // base price), never against a computed total.
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  minPriceCentavos?: number | null;

  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  maxPriceCentavos?: number | null;

  // ── Platform pricing / suggested defaults ────────────────────────────────
  // Under PLATFORM_FIXED these ARE the price. Under WASHER_SET they are the
  // fallback a washer is charged at until she sets her own — which is what
  // keeps every pre-existing washer priced exactly as before.
  //
  // Integer centavos, matching the rest of the system's money representation.

  /**
   * How the platform's own numbers are charged, when pricingControl is
   * PLATFORM_FIXED. Meaningless under WASHER_SET, where the washer picks a
   * model from `allowedPricingModels` — except as the shape of the fallback
   * price she is on until she does.
   *
   * BASE_EXCESS is the default because it is what every template did before
   * this field existed: a platform-priced service used to be hardcoded to
   * base + excess. Defaulting anywhere else would silently re-price the
   * existing catalog.
   */
  @Field(() => WasherPricingModel)
  @Prop({
    type: String,
    enum: WasherPricingModel,
    default: WasherPricingModel.BASE_EXCESS,
  })
  platformPricingModel!: WasherPricingModel;

  /**
   * The headline amount: per kg (PER_KG), per load (PER_LOAD), per item
   * (PER_ITEM), or the price of the first `baseWeightKg` kilos (BASE_EXCESS).
   */
  @Field(() => Float)
  @Prop({ required: true, min: 0 })
  basePriceCentavos!: number;

  /** BASE_EXCESS: kilos covered by `basePriceCentavos`. */
  @Field(() => Float)
  @Prop({ required: true, min: 0 })
  baseWeightKg!: number;

  /** BASE_EXCESS: charged per kilo above `baseWeightKg`. */
  @Field(() => Float)
  @Prop({ required: true, min: 0 })
  excessRatePerKgCentavos!: number;

  /**
   * PER_LOAD: kilos per machine run. Unlike a washer-set per-load offering —
   * where the capacity is her own machine's — a platform-fixed load is a
   * platform promise, so every washer offering it runs the same size load.
   */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  platformLoadCapacityKg?: number | null;

  /** PER_ITEM: what is being counted. */
  @Field(() => WasherServiceUnit, { nullable: true })
  @Prop({ type: String, enum: WasherServiceUnit, default: null })
  platformUnit?: WasherServiceUnit | null;

  /** PER_KG / BASE_EXCESS: smallest weight billed. */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  platformMinBillableKg?: number | null;

  /**
   * §10 — how long the work itself takes, in hours, once the provider has the
   * laundry. Feeds the customer's "Estimated ready" line ("Pickup Aug 14 ·
   * 10:00 AM → Ready Aug 15 · 10:00 AM").
   *
   * Deliberately NOT something the customer chooses. Laundry is not an
   * appointment: asking a customer to pick a completion time invites a promise
   * the provider never made. Turnaround belongs to the service, so Standard
   * Wash can be 24 h while Express is 6 h.
   *
   * Hours, not minutes, because the merchant `Service` equivalent
   * (estimatedMinutes) is already minutes and laundry turnaround is never
   * expressed that finely — a template saying "1440" reads worse than "24".
   * Null means the platform makes no promise and the UI omits the line.
   */
  @Field(() => Float, { nullable: true })
  @Prop({ type: Number, default: null, min: 0 })
  turnaroundHours?: number | null;

  @Field()
  @Prop({ default: true })
  isActive!: boolean;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WasherServiceTemplateSchema = SchemaFactory.createForClass(
  WasherServiceTemplate,
);
