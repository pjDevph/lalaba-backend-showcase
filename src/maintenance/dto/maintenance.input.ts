import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { MaintenanceType } from '../schemas/maintenance-config.schema';

@InputType()
export class MaintenanceAppStateInput {
  @IsBoolean()
  @Field()
  active!: boolean;

  @IsEnum(MaintenanceType)
  @Field(() => MaintenanceType)
  mode!: MaintenanceType;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  @MaxLength(TEXT_LIMITS.LONG)
  message?: string | null;

  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  scheduledStart?: string | null;

  @IsOptional()
  @IsDateString()
  @Field(() => String, { nullable: true })
  scheduledEnd?: string | null;
}

@InputType()
export class UpdateMaintenanceConfigInput {
  @IsBoolean()
  @Field()
  globalEmergencyActive!: boolean;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  @MaxLength(TEXT_LIMITS.LONG)
  globalEmergencyMessage?: string | null;

  @ValidateNested()
  @Type(() => MaintenanceAppStateInput)
  @Field(() => MaintenanceAppStateInput)
  customerApp!: MaintenanceAppStateInput;

  @ValidateNested()
  @Type(() => MaintenanceAppStateInput)
  @Field(() => MaintenanceAppStateInput)
  partnerApp!: MaintenanceAppStateInput;

  /** Blank clears it. Validated as an address so a typo does not ship as a
   *  dead mailto on the one screen someone reaches when nothing else works. */
  @IsOptional()
  @IsEmail()
  @Field(() => String, { nullable: true })
  @MaxLength(TEXT_LIMITS.SHORT)
  supportEmail?: string | null;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  @MaxLength(TEXT_LIMITS.SHORT)
  supportPhone?: string | null;

  @IsArray()
  @IsString({ each: true })
  @Field(() => [String])
  bypassUids!: string[];
}
