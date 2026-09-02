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
import { FaqCategory } from '../schemas/faq-entry.schema';

@InputType()
export class CreateFaqEntryInput {
  @IsEnum(FaqCategory)
  @Field(() => FaqCategory)
  category!: FaqCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Field()
  question!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Field()
  answer!: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;
}

@InputType()
export class UpdateFaqEntryInput {
  @IsOptional()
  @IsEnum(FaqCategory)
  @Field(() => FaqCategory, { nullable: true })
  category?: FaqCategory;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Field({ nullable: true })
  question?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @Field({ nullable: true })
  answer?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isPublished?: boolean;
}
