import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsNumber,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsDateString,
} from 'class-validator';

// A single live-location fix from the courier's device. Carries the metadata the
// server needs to validate it (sequence + recordedAt guard against out-of-order
// delivery; accuracy/speed feed sanity checks) — see live-tracking spec §2–§3.
@InputType()
export class UpdateCourierLocationInput {
  @Field(() => Float)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  // Metres. Larger = less certain. Fixes worse than a threshold are rejected.
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  accuracy?: number;

  // m/s from the device; may be null when the platform can't determine it.
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  speed?: number;

  // Degrees (0–360); may be null.
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  heading?: number;

  // Device capture time (ISO). Used with `sequence` to reject stale/out-of-order
  // fixes that arrive late over the network.
  @Field()
  @IsDateString()
  recordedAt!: string;

  // Monotonic counter per courier device — the primary out-of-order guard.
  @Field(() => Int)
  @IsInt()
  @Min(0)
  sequence!: number;
}
