import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PermissionDocument = Permission & Document;

@ObjectType()
@Schema({ collection: 'permissions', timestamps: true })
export class Permission {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ required: true, unique: true })
  permissionName!: string;

  @Field()
  @Prop({ required: true })
  description!: string;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const PermissionSchema = SchemaFactory.createForClass(Permission);
