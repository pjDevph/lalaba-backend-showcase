import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from '../schemas/admin-audit-event.schema';

@InputType()
export class AdminAuditFilterInput {
  /** Action types to include. Empty/omitted = all. */
  @IsOptional()
  @IsArray()
  @IsEnum(AdminAuditAction, { each: true })
  @Field(() => [AdminAuditAction], { nullable: true })
  actions?: AdminAuditAction[];

  /** "What did this admin do" — the most common auditor question. */
  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  actorUid?: string;

  @IsOptional()
  @IsEnum(AdminAuditTargetType)
  @Field(() => AdminAuditTargetType, { nullable: true })
  targetType?: AdminAuditTargetType;

  /** "What was done to this washer" — the second most common. */
  @IsOptional()
  @IsString()
  @Field(() => ID, { nullable: true })
  targetId?: string;

  @IsOptional()
  @Field({ nullable: true })
  dateFrom?: Date;

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
