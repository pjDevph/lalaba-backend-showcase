import { InputType, Field, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

@InputType()
export class RatingFilterInput {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Field(() => Int, { nullable: true, defaultValue: 20 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
