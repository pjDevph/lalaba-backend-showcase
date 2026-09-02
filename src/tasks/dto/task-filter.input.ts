import { InputType, Field, Int } from '@nestjs/graphql';
import { IsString, IsOptional, IsBoolean, IsInt, Min } from 'class-validator';

@InputType()
export class TaskFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  branchId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isVisibleToStaff?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
