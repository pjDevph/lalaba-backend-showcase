import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';
import { ChatLegType } from '../schemas/conversation.schema';

@InputType()
export class SendMessageInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  conversationId!: string;

  // Optional at the DTO level: an image-only message has no text. "At least
  // one of text/imageKey" is enforced in ChatService.sendMessage rather than
  // via decorators — a @ValidateIf combo for "one of two fields" is awkward
  // next to a clear service-level guard (same style as the SEC-005 checks
  // elsewhere in this module).
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Field({ nullable: true })
  text?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  imageKey?: string;
}

@InputType()
export class StartConversationInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  branchId!: string;

  @IsEnum(ProviderType)
  @Field(() => ProviderType)
  providerType!: ProviderType;

  // Required: a provider thread is scoped to one order, so every conversation
  // must name the order it belongs to.
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  orderId!: string;
}

// Customer opens (or reuses) the thread with the rider assigned to one leg of an
// order. The courier is resolved server-side from the order's leg assignment.
@InputType()
export class StartCourierConversationInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  orderId!: string;

  @IsEnum(ChatLegType)
  @Field(() => ChatLegType)
  leg!: ChatLegType;
}
