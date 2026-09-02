import {
  InputType,
  Field,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

// Superset of ProviderType with an ALL option for the discovery filter chips
// (screen 032: All / Laundromats / Home Washers).
export enum ProviderTypeFilter {
  ALL = 'all',
  MERCHANT = 'merchant',
  WASHER = 'washer',
}
registerEnumType(ProviderTypeFilter, { name: 'ProviderTypeFilter' });

export enum ProviderSort {
  NEAREST = 'nearest',
  TOP_RATED = 'top_rated',
}
registerEnumType(ProviderSort, { name: 'ProviderSort' });

@InputType()
export class DiscoverProvidersInput {
  // Customer's chosen delivery location. When omitted, distance is not
  // computed and radius filtering is skipped (results still returned).
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Field(() => Float, { nullable: true })
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Field(() => Float, { nullable: true })
  longitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Field(() => Float, { nullable: true, defaultValue: 15 })
  radiusKm?: number;

  @IsOptional()
  @IsEnum(ProviderTypeFilter)
  @Field(() => ProviderTypeFilter, {
    nullable: true,
    defaultValue: ProviderTypeFilter.ALL,
  })
  providerType?: ProviderTypeFilter;

  // ServiceCategory value (e.g. "wash_and_fold") to narrow to providers that
  // offer it. Free-form string so the app can pass any category chip.
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  category?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  search?: string;

  // Minimum average rating (e.g. 4 or 4.5). Providers below this are excluded.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  @Field(() => Float, { nullable: true })
  minRating?: number;

  // Only providers currently open (or accepting bookings). Derived from the
  // provider's operating hours / availability.
  @IsOptional()
  @Field({ nullable: true })
  openNow?: boolean;

  @IsOptional()
  @IsEnum(ProviderSort)
  @Field(() => ProviderSort, {
    nullable: true,
    defaultValue: ProviderSort.NEAREST,
  })
  sort?: ProviderSort;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Field(() => Int, { nullable: true, defaultValue: 30 })
  limit?: number;
}
