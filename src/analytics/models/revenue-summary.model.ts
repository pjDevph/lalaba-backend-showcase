import { ObjectType, Field, Float, Int } from '@nestjs/graphql';

@ObjectType()
export class RevenueSummary {
  @Field(() => Float) totalRevenue!: number;
  @Field(() => Int) totalOrders!: number;
  @Field(() => Float) avgOrderValue!: number;
  @Field(() => Float) totalRefunded!: number;
  @Field(() => Float) totalDiscounts!: number;
}

@ObjectType()
export class BranchRevenueSummary {
  @Field() branchId!: string;
  @Field() branchName!: string;
  @Field(() => Float) totalRevenue!: number;
  @Field(() => Int) totalOrders!: number;
  @Field(() => Float) avgOrderValue!: number;
}
