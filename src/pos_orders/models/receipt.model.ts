import { ObjectType, Field, Float } from '@nestjs/graphql';
import { OrderItem, DiscountType } from '../schemas/pos-order.schema';
import { PosTransaction } from '../../pos_transactions/schemas/pos-transaction.schema';

@ObjectType()
class ReceiptBranch {
  @Field() branchName!: string;
  @Field() branchPhoneNumber!: string;
  @Field() regionName!: string;
  @Field() cityMunicipalityName!: string;
  @Field() streetAddress!: string;
}

@ObjectType()
export class Receipt {
  @Field() orderId!: string;
  @Field() claimCode!: string;
  @Field({ nullable: true }) customerName?: string;
  @Field() processedBy!: string;
  @Field() createdAt!: Date;

  @Field(() => ReceiptBranch) branch!: ReceiptBranch;

  @Field(() => [OrderItem]) items!: OrderItem[];

  @Field(() => Float) subtotal!: number;
  @Field(() => DiscountType, { nullable: true }) discountType?: DiscountType;
  @Field(() => Float, { nullable: true }) discountValue?: number;
  @Field(() => Float) discount!: number;
  @Field(() => Float) totalAmount!: number;

  @Field(() => [PosTransaction]) transactions!: PosTransaction[];
}
