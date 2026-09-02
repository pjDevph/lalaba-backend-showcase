import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { HydratedDocument } from 'mongoose';

export type ServiceAreaDocument = HydratedDocument<ServiceArea>;

/**
 * A single published location line — the website's `serviceAreas: string[]`
 * today is empty because there was nowhere to manage it from. One field on
 * purpose: this is "confirmed coverage" copy for the marketing site, not the
 * operational service-area/geofencing data the apps already use elsewhere.
 */
@ObjectType()
@Schema({ collection: 'site_service_areas', timestamps: true })
export class ServiceArea {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Field()
  @Prop({ type: Number, default: 0 })
  order!: number;

  @Field()
  @Prop({ type: Boolean, default: true })
  isPublished!: boolean;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const ServiceAreaSchema = SchemaFactory.createForClass(ServiceArea);
ServiceAreaSchema.index({ order: 1 });
