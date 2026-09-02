import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  FeeBasis,
  FeeCalculationType,
  FeeCategory,
  FeeChargedTo,
  FeeDeductionSource,
  FeePayerRole,
  FeeTaxTreatment,
} from '../schemas/platform-fee-rule.schema';

/**
 * One input for both create and update, because a rule is append-only: an
 * "update" publishes a complete new version rather than patching fields, so a
 * partial input would leave the reader guessing whether an omitted `maxFee`
 * means "unchanged" or "cleared". Everything is stated every time.
 *
 * The distinction lives in the mutation: createPlatformFeeRule derives a new
 * ruleKey, updatePlatformFeeRule takes an existing one.
 */
@InputType()
export class SavePlatformFeeRuleInput {
  @IsString()
  @MaxLength(80)
  @Field()
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Field({ nullable: true })
  description?: string;

  // Immutable after create — a rule that changes payer is a different rule, and
  // silently repointing it would rewrite the meaning of its whole history. The
  // service rejects a change here on update.
  @IsEnum(FeePayerRole)
  @Field(() => FeePayerRole)
  appliesTo!: FeePayerRole;

  // Immutable after create, for the same reason: the pricing code matches on
  // category, so changing it moves the rule to a different part of the maths.
  @IsEnum(FeeCategory)
  @Field(() => FeeCategory)
  category!: FeeCategory;

  @IsEnum(FeeCalculationType)
  @Field(() => FeeCalculationType)
  calculationType!: FeeCalculationType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float, { nullable: true })
  percent?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  fixedAmountCentavos?: number | null;

  @IsEnum(FeeBasis)
  @Field(() => FeeBasis)
  basis!: FeeBasis;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  minFeeCentavos?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  maxFeeCentavos?: number | null;

  @IsEnum(FeeChargedTo)
  @Field(() => FeeChargedTo)
  chargedTo!: FeeChargedTo;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float, { nullable: true })
  customerSharePercent?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float, { nullable: true })
  providerSharePercent?: number | null;

  @IsEnum(FeeDeductionSource)
  @Field(() => FeeDeductionSource)
  deductFrom!: FeeDeductionSource;

  @IsEnum(FeeTaxTreatment)
  @Field(() => FeeTaxTreatment)
  taxTreatment!: FeeTaxTreatment;

  @IsBoolean()
  @Field()
  applyVat!: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Field(() => Float, { nullable: true })
  vatRatePercent?: number | null;

  @IsBoolean()
  @Field()
  stackable!: boolean;

  @IsBoolean()
  @Field()
  isActive!: boolean;

  // A future date schedules the change: resolution ignores the version until
  // it lands, so the previous one stays in force in the meantime.
  @IsDate()
  @Field()
  effectiveFrom!: Date;

  @IsOptional()
  @IsDate()
  @Field(() => Date, { nullable: true })
  effectiveUntil?: Date | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  changeReason?: string;
}
