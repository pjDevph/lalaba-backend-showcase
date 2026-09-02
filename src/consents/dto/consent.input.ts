import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class ConsentInput {
  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  policyType!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  version!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  locale?: string;
}
