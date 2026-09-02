import { ObjectType, Field, Float, Int } from '@nestjs/graphql';

@ObjectType()
export class RevenueDataPoint {
  @Field() period!: string;
  @Field(() => Float) totalRevenue!: number;
  @Field(() => Int) orderCount!: number;
  @Field(() => Float) avgOrderValue!: number;
}
