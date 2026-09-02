import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  TicketCategory,
  TicketPriority,
  TicketSource,
} from '../schemas/support-ticket.schema';

@InputType()
export class CreateTicketInput {
  /** The account the ticket is ABOUT — not the agent filing it. */
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  requesterUid!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Field()
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  body!: string;

  @IsEnum(TicketCategory)
  @Field(() => TicketCategory)
  category!: TicketCategory;

  /** Omitted = ADMIN, since anything without a channel was raised in-panel. */
  @IsOptional()
  @IsEnum(TicketSource)
  @Field(() => TicketSource, { nullable: true })
  source?: TicketSource;

  /** Omitted lets the category decide — see AUTO_PRIORITY in the service. */
  @IsOptional()
  @IsEnum(TicketPriority)
  @Field(() => TicketPriority, { nullable: true })
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  orderId?: string;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  providerBranchId?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  paymentReference?: string;
}
