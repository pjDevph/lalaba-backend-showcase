import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Admin/support oversight listing — searches by customer or provider name,
// not scoped to a single participant the way myConversations is.
@InputType()
export class AdminConversationsInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Field(() => Int, { nullable: true })
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Field(() => Int, { nullable: true })
  offset?: number;
}
