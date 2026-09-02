import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PromoDiscountType, PromoScope } from '../schemas/promo-code.schema';

@InputType()
export class CreatePromoInput {
  /** Stored uppercase regardless of what is typed. Letters, digits and dashes only. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'Code may only contain letters, numbers and dashes',
  })
  @Field()
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Field()
  description!: string;

  @IsEnum(PromoDiscountType)

  /** Omit for an ordinary order discount — see PromoScope. */
  @Field(() => PromoScope, { nullable: true })
  @IsOptional()
  @IsEnum(PromoScope)
  scope?: PromoScope;

  @Field(() => PromoDiscountType)
  discountType!: PromoDiscountType;

  @IsInt()
  @Min(1)
  @Field(() => Int)
  discountValue!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  maxDiscountCentavos?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  minOrderValueCentavos?: number;

  /** Required and non-empty — see the schema's own comment on why. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Field(() => [String])
  targetRoleIds!: string[];

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  firstOrderOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  usageCapTotal?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true, defaultValue: 1 })
  usageCapPerCustomer?: number;

  /**
   * How many times ONE subject may use this — a customer, or a BRANCH on a
   * platform-fee incentive. Prefer this over `usageCapPerCustomer`, which it
   * supersedes; the older field stays only so existing codes and the admin
   * panel's current payload keep working.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  usageCapPerSubject?: number;

  @IsDate()
  @Field()
  startsAt!: Date;

  @IsOptional()
  @IsDate()
  @Field({ nullable: true })
  expiresAt?: Date;
}

@InputType()
export class UpdatePromoInput {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsDate()
  @Field({ nullable: true })
  startsAt?: Date;

  @IsOptional()
  @IsDate()
  @Field({ nullable: true })
  expiresAt?: Date;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Field(() => Int, { nullable: true })
  usageCapTotal?: number;
}

@InputType()
export class PromoFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  /** 'active' | 'scheduled' | 'expired' | 'exhausted' | 'disabled'. Computed, not stored. */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}

/** Redeeming a code needs to know the order it is being applied to. */
@InputType()
export class RedeemPromoInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  code!: string;

  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  customerUid!: string;

  @IsInt()
  @Min(0)
  @Field(() => Int)
  orderTotalCentavos!: number;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  orderId?: string;
}
