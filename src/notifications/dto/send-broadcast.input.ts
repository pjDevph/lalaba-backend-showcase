import { Field, InputType } from '@nestjs/graphql';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

@InputType()
export class SendBroadcastInput {
  /** Push title. Short — Android truncates around 65 characters. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(65)
  @Field()
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  @Field()
  body!: string;

  /**
   * Required and non-empty. An omitted audience must never mean "everyone" —
   * the most destructive possible broadcast should not be the one you get by
   * forgetting a field.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Field(() => [String])
  audienceRoleIds!: string[];

  /** Default false: a deactivated account should not be marketed to. */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  includeInactive?: boolean;
}
