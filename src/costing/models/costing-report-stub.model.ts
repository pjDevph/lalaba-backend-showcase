import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class CostingReportStub {
  @Field(() => ID) id!: string;
  @Field() date!: string;
}
