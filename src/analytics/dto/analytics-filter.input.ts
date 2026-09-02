import { InputType, Field, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum AnalyticsGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

registerEnumType(AnalyticsGranularity, { name: 'AnalyticsGranularity' });

@InputType()
export class AnalyticsFilterInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  branchId?: string;

  @Field() dateFrom!: Date;

  @Field() dateTo!: Date;

  @IsOptional()
  @IsEnum(AnalyticsGranularity)
  @Field(() => AnalyticsGranularity, { nullable: true })
  granularity?: AnalyticsGranularity;
}
