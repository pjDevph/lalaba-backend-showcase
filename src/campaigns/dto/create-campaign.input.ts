import { InputType, Field, Int, ID } from '@nestjs/graphql';
import {
  ArrayNotEmpty,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CampaignActionType,
  CampaignFrequency,
  CampaignStatus,
} from '../schemas/campaign.schema';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class CreateCampaignInput {
  @Field()
  @IsString()
  @MaxLength(TEXT_LIMITS.SHORT)
  name!: string;

  /** An empty audience would mean "nobody", which is never what an admin
   *  meant to configure — reject it rather than publish a dead campaign. */
  @Field(() => [String])
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  targetRoleIds!: string[];

  @Field()
  @IsString()
  @MaxLength(TEXT_LIMITS.SHORT)
  imageUrl!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT_LIMITS.SHORT)
  imagePath?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT_LIMITS.SHORT)
  altText?: string;

  @Field(() => CampaignFrequency)
  @IsEnum(CampaignFrequency)
  frequency!: CampaignFrequency;

  @Field(() => CampaignActionType, { nullable: true })
  @IsOptional()
  @IsEnum(CampaignActionType)
  actionType?: CampaignActionType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  promoId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT_LIMITS.SHORT)
  deepLink?: string;

  @Field()
  @IsDate()
  startsAt!: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  endsAt?: Date;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @Field(() => CampaignStatus, { nullable: true })
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;
}
