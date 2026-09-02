import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

@ObjectType()
export class PlatformAnalyticsDayPoint {
  /** YYYY-MM-DD, PH timezone. */
  @Field() date!: string;
  @Field(() => Int) orders!: number;
  @Field(() => Float) gmvCentavos!: number;
}

@ObjectType()
export class PlatformProviderTypeBreakdown {
  @Field(() => ProviderType) providerType!: ProviderType;
  @Field(() => Int) orders!: number;
  @Field(() => Float) gmvCentavos!: number;
}

@ObjectType()
export class TopPlatformProvider {
  @Field(() => ID) branchId!: string;
  @Field() providerName!: string;
  @Field(() => ProviderType) providerType!: ProviderType;
  @Field(() => Int) orders!: number;
  @Field(() => Float) gmvCentavos!: number;
}

@ObjectType()
export class PlatformOverview {
  /** Orders placed in range, every status — the demand signal. */
  @Field(() => Int) ordersCreated!: number;
  /** Orders that reached COMPLETED with completedAt in range — the revenue signal. */
  @Field(() => Int) ordersCompleted!: number;
  @Field(() => Int) ordersCancelled!: number;
  /** ordersCancelled / ordersCreated. 0 when ordersCreated is 0. */
  @Field(() => Float) cancellationRate!: number;
  /** What customers paid on completed orders — customerTotalCentavos, falling back to the estimate for pre-fulfillment-fee orders. */
  @Field(() => Float) gmvCentavos!: number;
  @Field(() => Float) platformFeeRevenueCentavos!: number;
  /** gmvCentavos / ordersCompleted. 0 when ordersCompleted is 0. */
  @Field(() => Float) averageOrderValueCentavos!: number;
  /** Distinct customers with a completed order in range. */
  @Field(() => Int) activeCustomers!: number;
  /** Distinct provider branches with a completed order in range. */
  @Field(() => Int) activeProviders!: number;
  @Field(() => [PlatformAnalyticsDayPoint]) daily!: PlatformAnalyticsDayPoint[];
  @Field(() => [PlatformProviderTypeBreakdown])
  byProviderType!: PlatformProviderTypeBreakdown[];
  /** Top 10 branches by GMV in range. */
  @Field(() => [TopPlatformProvider]) topProviders!: TopPlatformProvider[];
}
