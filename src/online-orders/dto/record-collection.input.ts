import { InputType, Field, Float, Int, ID } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod, PaymentTiming } from '../schemas/order-status.enum';

// Actual measured quantity for ONE service line, so a multi-service order can be
// weighed/counted per line (e.g. a per-kilo Wash&Fold + a per-piece Bedding).
@InputType()
export class LineActualInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  serviceRefId!: string;

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
}

// The single atomic "weigh + price + payment collected" action — used for
// drop-off receipt (receiveAtCounter) and the return leg (recordDelivery /
// verifySelfPickup), per the settled payment model (§14). The pickup leg no
// longer uses this: recordPickup was split into recordPickupWeight +
// recordPickupPayment (see dto/record-pickup.input.ts) so the customer can
// see the confirmed weight/total before the courier collects payment.
@InputType()
export class RecordCollectionInput {
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

  // Preferred: one entry per service line, so each line prices off its own
  // measured quantity. When present it takes precedence over the order-level
  // actualWeightKg/actualPieceCount above (kept for backward compatibility).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineActualInput)
  @Field(() => [LineActualInput], { nullable: true })
  lineActuals?: LineActualInput[];

  // What the customer chose once they could see the real weighed total.
  // Omitted ⇒ ON_PICKUP, so every client written before deferred settlement
  // existed keeps working untouched. AT_FINAL_HANDOVER is rejected unless the
  // order's provider snapshot carries allowsPayAtHandover, and cannot be
  // combined with payment details — deferring and collecting are exclusive.
  // Only meaningful at pickup/receipt; ignored on the settlement calls, which
  // are collecting by definition.
  @IsOptional()
  @IsEnum(PaymentTiming)
  @Field(() => PaymentTiming, { nullable: true })
  paymentTiming?: PaymentTiming;

  // Required when payment is actually being collected in this call. Omitted
  // when the customer defers to final handover — pricing finalizes now, the
  // whole amount is collected later at recordDelivery/verifySelfPickup.
  @IsOptional()
  @IsEnum(PaymentMethod)
  @Field(() => PaymentMethod, { nullable: true })
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  referenceId?: string; // required in practice for EWALLET_OUTSIDE_APP, validated in service

  // Storage object keys returned by uploadHandoverProof, stamped onto the
  // order as the proof for this leg. Keys, not URLs — the frames are private
  // and read back through short-lived signed URLs.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  proofObjectKeys?: string[];

  // Cash tender (GAP-H-017) — what the customer physically handed over.
  // Optional until DECISION_REQUIRED-004 settles the full tender model; when
  // present it must cover the amount due, and change is computed server-side.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  tenderedCentavos?: number;
}
