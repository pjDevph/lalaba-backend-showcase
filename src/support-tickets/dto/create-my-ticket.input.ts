import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { TicketCategory } from '../schemas/support-ticket.schema';

/**
 * The customer/partner-app version of CreateTicketInput (my-support-tickets.
 * resolver.ts) — deliberately narrower. No requesterUid (always the caller),
 * no source (derived from the caller's role), no priority override (a
 * requester declaring her own ticket URGENT would defeat AUTO_PRIORITY).
 */
@InputType()
export class CreateMyTicketInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Field()
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.LONG)
  body!: string;

  @IsEnum(TicketCategory)
  @Field(() => TicketCategory)
  category!: TicketCategory;

  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  orderId?: string;
}
