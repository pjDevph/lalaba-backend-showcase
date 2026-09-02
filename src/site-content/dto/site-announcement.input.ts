import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SiteAnnouncementAudience } from '../schemas/site-announcement.schema';

@InputType()
export class CreateSiteAnnouncementInput {
  @IsOptional()
  @IsEnum(SiteAnnouncementAudience)
  @Field(() => SiteAnnouncementAudience, { nullable: true })
  audience?: SiteAnnouncementAudience;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Field()
  eyebrow!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @Field()
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Field()
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Field({ nullable: true })
  promoCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Field({ nullable: true })
  validityText?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Field()
  ctaText!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  ctaUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  image?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;
}

@InputType()
export class UpdateSiteAnnouncementInput {
  @IsOptional()
  @IsEnum(SiteAnnouncementAudience)
  @Field(() => SiteAnnouncementAudience, { nullable: true })
  audience?: SiteAnnouncementAudience;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Field({ nullable: true })
  eyebrow?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  @Field({ nullable: true })
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Field({ nullable: true })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Field({ nullable: true })
  promoCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Field({ nullable: true })
  validityText?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Field({ nullable: true })
  ctaText?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Field({ nullable: true })
  ctaUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Field({ nullable: true })
  image?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isPublished?: boolean;
}
