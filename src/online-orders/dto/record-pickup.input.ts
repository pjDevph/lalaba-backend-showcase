import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod, PaymentTiming } from '../schemas/order-status.enum';
import { LineActualInput } from './record-collection.input';

// Step 1 of the split pickup flow (weigh + price only — no payment). See
// recordPickupWeight in the service for the full rationale: this used to be
// half of the atomic RecordCollectionInput payload that recordPickup
// accepted; splitting it lets the confirmed weight/total reach the customer
// before the courier collects money.
@InputType()
export class RecordPickupWeightInput {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true })
  actualWeightKg?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Int, { nullable: true })
  actualPieceCount?: number;

  // Preferred: one entry per service line — see LineActualInput. Takes
  // precedence over the order-level actualWeightKg/actualPieceCount above.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineActualInput)
  @Field(() => [LineActualInput], { nullable: true })
  lineActuals?: LineActualInput[];

  // Storage object keys returned by uploadHandoverProof, stamped onto the
  // order as the proof for this leg. Keys, not URLs — the frames are private
  // and read back through short-lived signed URLs.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  proofObjectKeys?: string[];
}

// Step 2 of the split pickup flow (payment only). Only valid once the order
// is in PICKUP_WEIGHED — pricing must already be finalized so there is a real
// amount to collect (or defer).
@InputType()
export class RecordPickupPaymentInput {
  // What the customer chose once they could see the real weighed total.
  // Omitted ⇒ ON_PICKUP, so every client written before deferred settlement
  // existed keeps working untouched. AT_FINAL_HANDOVER is rejected unless the
  // order's provider snapshot carries allowsPayAtHandover, and cannot be
  // combined with payment details — deferring and collecting are exclusive.
  @IsOptional()
  @IsEnum(PaymentTiming)
  @Field(() => PaymentTiming, { nullable: true })
  paymentTiming?: PaymentTiming;

  // Required when payment is actually being collected in this call. Omitted
  // when the customer defers to final handover.
  @IsOptional()
  @IsEnum(PaymentMethod)
  @Field(() => PaymentMethod, { nullable: true })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  referenceId?: string; // required in practice for EWALLET_OUTSIDE_APP, validated in service

  // Cash tender (GAP-H-017) — what the customer physically handed over.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  tenderedCentavos?: number;
}
