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
import {
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from '../schemas/support-ticket.schema';

@InputType()
export class TicketFilterInput {
  /** Exact ticket number, subject, or requester name. */
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  search?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(TicketStatus, { each: true })
  @Field(() => [TicketStatus], { nullable: true })
  statuses?: TicketStatus[];

  /**
   * The default inbox view: everything where the clock is on us. Ignored when
   * `statuses` is given, since that is a more specific request.
   */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  activeOnly?: boolean;

  @IsOptional()
  @IsArray()
  @IsEnum(TicketSource, { each: true })
  @Field(() => [TicketSource], { nullable: true })
  sources?: TicketSource[];

  @IsOptional()
  @IsArray()
  @IsEnum(TicketPriority, { each: true })
  @Field(() => [TicketPriority], { nullable: true })
  priorities?: TicketPriority[];

  @IsOptional()
  @IsArray()
  @IsEnum(TicketCategory, { each: true })
  @Field(() => [TicketCategory], { nullable: true })
  categories?: TicketCategory[];

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  assignedToUid?: string;

  /** Distinct from "no assignee filter" — this is the queue nobody owns. */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  unassignedOnly?: boolean;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  orderId?: string;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  requesterUid?: string;

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
