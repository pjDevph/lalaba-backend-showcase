import { ObjectType, Field, Float } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

// --- 1. PSGC BRANCH ADDRESS ---
@ObjectType()
@Schema({ _id: false })
export class BranchAddress {
  @Field({ nullable: true }) @Prop({ default: null }) unit?: string;
  @Field() @Prop({ required: true }) regionName!: string;
  @Field() @Prop({ required: true }) provinceName!: string;
  @Field() @Prop({ required: true }) cityMunicipalityName!: string;
  @Field() @Prop({ required: true }) barangayName!: string;
  @Field() @Prop({ required: true }) streetAddress!: string;
  @Field({ nullable: true }) @Prop({ default: null }) zipCode?: string;
}
export const BranchAddressSchema = SchemaFactory.createForClass(BranchAddress);

// --- 2. MAP LOCATION (GEO) ---
@ObjectType()
@Schema({ _id: false })
export class MapLocation {
  @Field(() => Float) @Prop({ required: true }) latitude!: number;
  @Field(() => Float) @Prop({ required: true }) longitude!: number;
}
export const MapLocationSchema = SchemaFactory.createForClass(MapLocation);

// --- 3. OPERATING HOURS SLOTS ---
@ObjectType()
@Schema({ _id: false })
export class TimeSlot {
  @Field() @Prop({ required: true }) open!: string; // e.g., "07:00"
  @Field() @Prop({ required: true }) close!: string; // e.g., "20:00"
}
export const TimeSlotSchema = SchemaFactory.createForClass(TimeSlot);

@ObjectType()
@Schema({ _id: false })
export class DaySchedule {
  @Field() @Prop({ default: true }) isOpen!: boolean;
  @Field() @Prop({ default: false }) is24Hours!: boolean;
  @Field(() => [TimeSlot])
  @Prop({ type: [TimeSlotSchema], default: [] })
  timeSlots!: TimeSlot[];
}
export const DayScheduleSchema = SchemaFactory.createForClass(DaySchedule);

@ObjectType()
@Schema({ _id: false })
export class OperatingHours {
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  monday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  tuesday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  wednesday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  thursday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  friday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  saturday!: DaySchedule;
  @Field(() => DaySchedule)
  @Prop({ type: DayScheduleSchema })
  sunday!: DaySchedule;
}
export const OperatingHoursSchema =
  SchemaFactory.createForClass(OperatingHours);

// --- 4. RATING AGGREGATE (cached, updated on every new/edited/removed rating) ---
// One `count` covers every dimension since ratings are all-or-nothing (§ratings)
// — there's no per-dimension response count to track separately.
@ObjectType()
@Schema({ _id: false })
export class RatingAggregate {
  @Field() @Prop({ default: 0 }) count!: number;
  @Field(() => Float) @Prop({ default: 0 }) overallAverage!: number;
  @Field(() => Float) @Prop({ default: 0 }) qualityAverage!: number;
  @Field(() => Float) @Prop({ default: 0 }) speedAverage!: number;
  @Field(() => Float) @Prop({ default: 0 }) valueForMoneyAverage!: number;
  @Field(() => Float) @Prop({ default: 0 }) deliveryAverage!: number;
  @Field(() => Float) @Prop({ default: 0 }) communicationAverage!: number;
}
export const RatingAggregateSchema =
  SchemaFactory.createForClass(RatingAggregate);
