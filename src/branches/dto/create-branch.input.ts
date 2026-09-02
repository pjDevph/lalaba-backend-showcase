import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsBoolean,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  Min,
  Max,
  Matches,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { Type } from 'class-transformer';
import { BranchBusinessType } from '../schemas/branch.schema';

@InputType()
class BranchAddressInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  unit?: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  regionName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  provinceName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  cityMunicipalityName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  barangayName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  streetAddress!: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  zipCode?: string;
}

@InputType()
class MapLocationInput {
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Field(() => Float)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Field(() => Float)
  longitude!: number;
}

@InputType()
class TimeSlotInput {
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'open must be in HH:MM format' })
  @Field()
  open!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'close must be in HH:MM format' })
  @Field()
  close!: string;
}

@InputType()
class DayScheduleInput {
  @IsBoolean()
  @Field()
  isOpen!: boolean;

  @IsBoolean()
  @Field()
  is24Hours!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotInput)
  @Field(() => [TimeSlotInput], { defaultValue: [] })
  timeSlots!: TimeSlotInput[];
}

@InputType()
class OperatingHoursInput {
  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  monday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  tuesday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  wednesday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  thursday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  friday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  saturday!: DayScheduleInput;

  @ValidateNested()
  @Type(() => DayScheduleInput)
  @Field(() => DayScheduleInput)
  sunday!: DayScheduleInput;
}

@InputType()
export class CreateBranchInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  branchName!: string;

  @ValidateNested()
  @Type(() => BranchAddressInput)
  @Field(() => BranchAddressInput)
  branchAddress!: BranchAddressInput;

  @ValidateNested()
  @Type(() => MapLocationInput)
  @Field(() => MapLocationInput)
  branchMapLocation!: MapLocationInput;

  @IsString()
  @Matches(/^09\d{9}$/, {
    message: 'branchPhoneNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  @Field()
  branchPhoneNumber!: string;

  @ValidateNested()
  @Type(() => OperatingHoursInput)
  @Field(() => OperatingHoursInput)
  operatingHours!: OperatingHoursInput;

  @IsOptional()
  @IsString()
  @Matches(/^09\d{9}$/, {
    message: 'gcashNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  @Field({ nullable: true })
  gcashNumber?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  coverPhotoUrl?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  description?: string;

  // ── Business registration details ───────────────────────────────────────
  // Optional so existing create/update flows are unaffected; the verification
  // screen is what actually asks for them.
  @IsOptional()
  @IsEnum(BranchBusinessType)
  @Field(() => BranchBusinessType, { nullable: true })
  businessType?: BranchBusinessType;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  dtiRegistrationNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{3}(-\d{3,5})?$/, {
    message: 'tin must be in the format 000-000-000 or 000-000-000-00000',
  })
  @Field({ nullable: true })
  tin?: string;

  @IsOptional()
  @IsEmail({}, { message: 'businessEmail must be a valid email address' })
  @Field({ nullable: true })
  businessEmail?: string;
}
