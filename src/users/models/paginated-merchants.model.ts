import { ObjectType, Field, Int, ID } from '@nestjs/graphql';

@ObjectType()
export class MerchantSummary {
  @Field(() => ID) _id!: string;
  @Field() firstName!: string;
  @Field() lastName!: string;
  @Field() email!: string;
  @Field() phoneNumber!: string;
  @Field() isActive!: boolean;
  @Field() createdAt!: Date;
  // Active branches owned by this merchant — computed, not stored on the user.
  @Field(() => Int) branchCount!: number;
}

@ObjectType()
export class PaginatedMerchants {
  @Field(() => [MerchantSummary]) data!: MerchantSummary[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
