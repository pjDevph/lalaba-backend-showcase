import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ObjectType, Field } from '@nestjs/graphql';

@ObjectType()
@Schema({ _id: false })
export class HomeAddress {
  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  unit?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  streetAddress?: string | null; // <-- Added '?' before the colon

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  barangayName?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  barangayCode?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  cityMunicipalityName?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  cityMunicipalityCode?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  provinceName?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  provinceCode?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  regionName?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  regionCode?: string | null;

  @Prop({ type: String, default: null })
  @Field(() => String, { nullable: true })
  zipCode?: string | null;
}

export const HomeAddressSchema = SchemaFactory.createForClass(HomeAddress);
