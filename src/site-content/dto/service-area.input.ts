import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

@InputType()
export class CreateServiceAreaInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Field()
  name!: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;
}

@InputType()
export class UpdateServiceAreaInput {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Field({ nullable: true })
  name?: string;

  @IsOptional()
  @IsInt()
  @Field(() => Int, { nullable: true })
  order?: number;

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isPublished?: boolean;
}
