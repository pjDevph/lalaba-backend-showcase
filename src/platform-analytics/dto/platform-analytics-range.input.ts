import { Field, InputType } from '@nestjs/graphql';
import { IsDate, IsOptional } from 'class-validator';

/**
 * Inclusive on both ends. Both bounds optional — omit `from` for "since the
 * beginning", omit `to` for "through now". Interpreted as full days in the
 * PH timezone (+08:00), matching statsToday's convention on the fee module —
 * an admin picking "Aug 1 to Aug 20" means both calendar days whole.
 */
@InputType()
export class PlatformAnalyticsRangeInput {
  @IsOptional()
  @IsDate()
  @Field({ nullable: true })
  from?: Date;

  @IsOptional()
  @IsDate()
  @Field({ nullable: true })
  to?: Date;
}
