import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

@ObjectType()
export class CostingOneOffCost {
  @Field() name!: string;
  @Field(() => Float) amount!: number;
}

@ObjectType()
export class CostingUnit {
  @Field() unit!: string;
  @Field(() => Float, { nullable: true }) qty?: number;
  @Field(() => Float, { nullable: true }) revenue?: number;
  @Field(() => Float, { nullable: true }) recipeCost?: number;
  @Field(() => Float, { nullable: true }) operatingCost?: number;
  @Field(() => Float, { nullable: true }) totalCost?: number;
  @Field(() => Float, { nullable: true }) costPerUnit?: number;
  @Field(() => Float, { nullable: true }) trueMargin?: number;
}

@ObjectType()
export class CostingBranch {
  @Field() branchId!: string;
  @Field({ nullable: true }) branchName?: string;
  @Field(() => Float, { nullable: true }) kilos?: number;
  @Field(() => Float, { nullable: true }) revenue?: number;
  @Field(() => Float, { nullable: true }) recipeCost?: number;
  @Field(() => Float, { nullable: true }) operatingCost?: number;
  @Field(() => Float, { nullable: true }) totalCost?: number;
  @Field(() => Float, { nullable: true }) costPerKilo?: number;
  @Field(() => Float, { nullable: true }) trueMargin?: number;
}

@ObjectType()
export class CostingReportEntry {
  @Field(() => ID) id!: string;
  @Field() date!: string;
  @Field(() => Float, { nullable: true }) kilos?: number;
  @Field(() => Float, { nullable: true }) revenue?: number;
  @Field(() => Float, { nullable: true }) recipeCost?: number;
  @Field(() => Float, { nullable: true }) electricity?: number;
  @Field(() => Float, { nullable: true }) lpg?: number;
  @Field(() => Float, { nullable: true }) water?: number;
  @Field(() => Float, { nullable: true }) additionalDaily?: number;
  @Field(() => Float, { nullable: true }) fixedTotal?: number;
  @Field(() => Float, { nullable: true }) operating?: number;
  @Field(() => Float, { nullable: true }) totalCost?: number;
  @Field(() => Float, { nullable: true }) costPerKilo?: number;
  @Field(() => Float, { nullable: true }) trueMargin?: number;
  @Field(() => Float, { nullable: true }) elecReading?: number;
  @Field(() => Float, { nullable: true }) waterReading?: number;
  @Field(() => Float, { nullable: true }) lpgReading?: number;
  @Field(() => [CostingOneOffCost], { nullable: true })
  oneOffCosts?: CostingOneOffCost[];
  @Field(() => [CostingUnit], { nullable: true }) units?: CostingUnit[];
  @Field(() => [CostingBranch], { nullable: true }) branches?: CostingBranch[];
  @Field({ nullable: true }) savedAt?: Date;
  @Field({ nullable: true }) createdBy?: string;
  @Field({ nullable: true }) updatedBy?: string;
  @Field({ nullable: true }) firstSavedAt?: Date;
}
