import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { AttemptResponsibility } from '../schemas/order-status.enum';

// Failed pickup/delivery evidence — same evidence-trust model as weight:
// accepted immediately given this evidence, no customer approval gate to
// finalize it (§13).
@InputType()
export class RecordAttemptInput {
  @IsOptional()
  @IsNumber()
  @Field(() => Float, { nullable: true })
  gpsLat?: number;

  @IsOptional()
  @IsNumber()
  @Field(() => Float, { nullable: true })
  gpsLng?: number;

  @IsOptional()
  @IsArray()
  @Field(() => [String], { nullable: true })
  photoUrls?: string[];

  @IsEnum(AttemptResponsibility)
  @Field(() => AttemptResponsibility)
  responsibility!: AttemptResponsibility;

  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.SHORT)
  reason!: string;
}
