import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// Mirrors the washer app's "Up to 8 photos" copy on the Online Store screen.
export const MAX_FEATURED_PHOTOS = 8;

@InputType()
class WasherAddressInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  unit?: string;

  @IsString()
  @Field()
  regionName!: string;

  @IsString()
  @Field()
  provinceName!: string;

  @IsString()
  @Field()
  cityMunicipalityName!: string;

  @IsString()
  @Field()
  barangayName!: string;

  @IsString()
  @Field()
  streetAddress!: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  zipCode?: string;
}

// Mirrors branches/dto/create-branch.input.ts MapLocationInput, decorators
// included. The class-validator decorators are not optional garnish here: the
// global pipe runs with `whitelist: true`, which DELETES any property that
// carries no validation decorator. Without them GraphQL accepted
// {latitude, longitude}, the pipe stripped both, and the service saw an empty
// object — so a perfectly good pin was rejected with "mapLocation requires
// both latitude and longitude", naming the two fields the caller had in fact
// sent. Range checks match the branch input so a washer pin and a branch pin
// cannot disagree about what a valid coordinate is.
@InputType()
class WasherMapLocationInput {
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Field(() => Float)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Field(() => Float)
  longitude!: number;
}

// Operating-hours inputs mirror the Branch OperatingHours sub-document shape
// (branches/schemas/sub-documents.schema.ts) and the validation rules of the
// branch DTO. They get washer-prefixed SDL names because the branch DTO
// already owns the TimeSlotInput / DayScheduleInput / OperatingHoursInput
// type names and those classes are private to create-branch.input.ts.
@InputType('WasherTimeSlotInput')
class WasherTimeSlotInput {
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'open must be in HH:MM format' })
  @Field()
  open!: string;

  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'close must be in HH:MM format' })
  @Field()
  close!: string;
}

@InputType('WasherDayScheduleInput')
class WasherDayScheduleInput {
  @IsBoolean()
  @Field()
  isOpen!: boolean;

  @IsBoolean()
  @Field()
  is24Hours!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WasherTimeSlotInput)
  @Field(() => [WasherTimeSlotInput], { defaultValue: [] })
  timeSlots!: WasherTimeSlotInput[];
}

@InputType('WasherOperatingHoursInput')
class WasherOperatingHoursInput {
  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  monday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  tuesday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  wednesday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  thursday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  friday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  saturday!: WasherDayScheduleInput;

  @ValidateNested()
  @Type(() => WasherDayScheduleInput)
  @Field(() => WasherDayScheduleInput)
  sunday!: WasherDayScheduleInput;
}

/**
 * NOTE ON THE DECORATORS BELOW — do not remove them.
 *
 * main.ts installs `ValidationPipe({ whitelist: true })`, which DELETES every
 * property that carries no class-validator decorator. These fields previously
 * had only `@Field()` (a GraphQL schema concern, invisible to class-validator),
 * so the pipe stripped all of them before the resolver ran: `updateWasherProfile`
 * returned success, `updatedAt` moved, and not one value was written. Cover
 * photo, description, bio, machine details and service radius were unsaveable
 * for every washer. Any field added here needs a validator or it will silently
 * vanish the same way.
 */
@InputType()
export class UpdateWasherProfileInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  displayName?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  phone?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  photoUrl?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  bio?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  machineType?: string;

  @IsOptional()
  @IsNumber()
  @Field(() => Float, { nullable: true })
  machineCapacityKg?: number;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  machineBrand?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WasherAddressInput)
  @Field(() => WasherAddressInput, { nullable: true })
  address?: WasherAddressInput;

  @IsOptional()
  @ValidateNested()
  @Type(() => WasherMapLocationInput)
  @Field(() => WasherMapLocationInput, { nullable: true })
  mapLocation?: WasherMapLocationInput;

  // Store hours — drives the "Open until 8:00 PM" status. Writes through to
  // WasherProfile.operatingHours (already present on the schema).
  @IsOptional()
  @ValidateNested()
  @Type(() => WasherOperatingHoursInput)
  @Field(() => WasherOperatingHoursInput, { nullable: true })
  operatingHours?: WasherOperatingHoursInput;

  @IsOptional()
  @IsNumber()
  @Field(() => Float, { nullable: true })
  serviceRadiusKm?: number;

  @IsOptional()
  @IsArray()
  @Field(() => [ID], { nullable: true })
  offeredServiceTemplateIds?: string[];

  // Storefront name — REQUIRED, and unclearable.
  //
  // `@ValidateIf` rather than `@IsOptional` on purpose: omitting the key is
  // fine (every other screen sends a partial patch), but a key that IS present
  // must hold a real name. @IsOptional would skip validation for null as well
  // as undefined, letting a client blank the field — and there is no fallback
  // behind it any more, so a blanked shop has no name at all. Trimmed before
  // the length checks, so "   " is a blank, not a 3-character name.
  @ValidateIf(
    (o: UpdateWasherProfileInput) =>
      (o as Record<string, unknown>).storeName !== undefined,
  )
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'storeName cannot be blank' })
  @MaxLength(60, { message: 'storeName must be at most 60 characters' })
  @Field({ nullable: true })
  storeName?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  coverPhotoUrl?: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  description?: string;

  // Gallery of up to 8 shots (equipment, workspace, finished laundry). The app
  // has collected these since launch, but with no field here the global
  // ValidationPipe's `whitelist: true` stripped them silently — uploads landed
  // in object storage and were never persisted.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FEATURED_PHOTOS)
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  featuredPhotos?: string[];
}
