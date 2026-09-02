import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';

export enum OrderSource {
  POS = 'pos',
  ONLINE = 'online',
}
registerEnumType(OrderSource, { name: 'OrderSource' });

// A flattened read-model row over pos_orders + online_orders (§6.2 correction —
// this is a query-time aggregation, not a shared physical collection). Use
// `source` + `id` to fetch the full record via the existing per-collection
// queries (getOrder / order) once a row is opened.
@ObjectType()
export class DashboardOrder {
  @Field(() => ID) id!: string;
  @Field(() => OrderSource) source!: OrderSource;
  @Field() branchId!: string;
  @Field({ nullable: true }) customerName?: string;
  @Field() statusLabel!: string;
  @Field(() => Float) totalAmountCentavos!: number;
  @Field({ nullable: true }) claimCode?: string;
  @Field() createdAt!: Date;
}
