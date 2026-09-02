import { Field, InputType } from '@nestjs/graphql';
import { IsArray, IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { NotificationCategory } from '../notification.enums';

/**
 * Narrows a feed page. Every field is optional and additive — an omitted
 * filter means "everything visible to me", which is the sane default for an
 * inbox.
 */
@InputType()
export class NotificationFilterInput {
  /** Restrict to these categories. Omitted or empty means all. */
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationCategory, { each: true })
  @Field(() => [NotificationCategory], { nullable: true })
  categories?: NotificationCategory[];

  /**
   * true → only unread. false and null both mean "no filter" rather than "only
   * read": an inbox has no use for a read-only view, and making the absent case
   * behave differently from the explicitly-false one is a trap.
   */
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  unreadOnly?: boolean;
}
