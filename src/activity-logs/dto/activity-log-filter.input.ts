import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ActivityStatus } from '../schemas/activity-log.schema';

@InputType()
export class ActivityLogFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  actorId?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  action?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  module?: string;

  @IsOptional()
  @IsEnum(ActivityStatus)
  @Field(() => ActivityStatus, { nullable: true })
  status?: ActivityStatus;

  @IsOptional()
  @Field({ nullable: true })
  dateFrom?: Date;

  @IsOptional()
  @Field({ nullable: true })
  dateTo?: Date;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  @Field(() => Int, { nullable: true, defaultValue: 10 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
