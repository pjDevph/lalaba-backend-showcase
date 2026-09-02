import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { OrderStatus, ProviderType } from '../schemas/order-status.enum';

@InputType()
export class AdminOrderFilterInput {
  /**
   * One box, several meanings — because support does not know which
   * identifier they are holding when the phone rings.
   *
   * Resolved, in order: an exact order id; an exact customer or provider uid;
   * a phone number (looked up against the USER record, not the order — the
   * order snapshot stores only `maskedPhone`, so the digits the customer reads
   * out would never match it); otherwise a case-insensitive substring of the
   * customer or provider name.
   */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  /**
   * Lifecycle states to include. A list rather than a single value: the panel
   * offers coarse buckets (Placed / In progress / Completed / Disputed /
   * Cancelled) and expands each into its member states, because 33 flat
   * checkboxes is not a filter anyone uses.
   */
  @IsOptional()
  @IsArray()
  @IsEnum(OrderStatus, { each: true })
  @Field(() => [OrderStatus], { nullable: true })
  statuses?: OrderStatus[];

  @IsOptional()
  @IsEnum(ProviderType)
  @Field(() => ProviderType, { nullable: true })
  providerType?: ProviderType;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  branchId?: string;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  customerUid?: string;

  /**
   * Only orders where the customer still owes money — the same
   * customerTotal-vs-collected comparison `unsettledOrders` uses, but usable
   * alongside any other filter rather than as its own screen.
   */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  outstandingBalanceOnly?: boolean;

  /** Placed on or after. Compared against createdAt. */
  @IsOptional()
  @Field({ nullable: true })
  dateFrom?: Date;

  /** Placed on or before. The service extends this to the end of that day. */
  @IsOptional()
  @Field({ nullable: true })
  dateTo?: Date;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Field(() => Int, { nullable: true, defaultValue: 25 })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}
