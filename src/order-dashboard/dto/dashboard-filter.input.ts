import { InputType, Field, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { OrderSource } from '../models/dashboard-order.model';

@InputType()
export class DashboardFilterInput {
  @IsOptional()
  @IsEnum(OrderSource)
  @Field(() => OrderSource, { nullable: true })
  source?: OrderSource;

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
