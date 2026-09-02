import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

@InputType()
export class DirectoryFilterInput {
  /**
   * Name, email, phone number, or an exact uid.
   *
   * Phone is matched on the last 10 digits so 09171234567, +639171234567 and
   * 0917 123 4567 all find the same person — the same normalisation the order
   * search uses, because support pastes the same string into both.
   */
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  /** roleIds to include. Empty = every role. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  roleIds?: string[];

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;

  /** Only accounts sharing a phone number with another account. */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  sharedPhoneOnly?: boolean;

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
