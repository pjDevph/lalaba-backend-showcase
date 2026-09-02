import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ObjectType, Field, ID } from '@nestjs/graphql';

export type RoleDocument = Role & Document;

@ObjectType()
@Schema({ collection: 'roles', timestamps: true })
export class Role {
  @Field(() => ID)
  _id!: string; // Maps cleanly to the native MongoDB ObjectId

  @Prop({ required: true, unique: true })
  @Field(() => String)
  roleId!: string; // e.g., "role_merchant"

  @Prop({ required: true })
  @Field(() => String)
  roleName!: string; // e.g., "merchant"

  @Prop({ required: true })
  @Field(() => String)
  description!: string;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
