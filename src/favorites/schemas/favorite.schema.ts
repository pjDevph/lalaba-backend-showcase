import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ProviderType } from '../../online-orders/schemas/order-status.enum';

export type FavoriteDocument = Favorite & Document;

// A customer's saved provider (screen 054). One row per (customer, branch);
// the unique index makes addFavorite idempotent.
@ObjectType()
@Schema({ collection: 'favorites', timestamps: true })
export class Favorite {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, required: true })
  uid!: string; // customer uid

  @Field(() => ID)
  @Prop({ type: String, required: true })
  branchId!: string;

  @Field(() => ProviderType)
  @Prop({ type: String, enum: ProviderType, required: true })
  providerType!: ProviderType;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const FavoriteSchema = SchemaFactory.createForClass(Favorite);
FavoriteSchema.index({ uid: 1, branchId: 1 }, { unique: true });
