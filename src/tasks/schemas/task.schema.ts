import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum TaskPriority {
  low = 'low',
  medium = 'medium',
  high = 'high',
  urgent = 'urgent',
}
registerEnumType(TaskPriority, { name: 'TaskPriority' });

export enum TaskCategory {
  general = 'general',
  cleaning = 'cleaning',
  maintenance = 'maintenance',
  delivery = 'delivery',
  purchasing = 'purchasing',
  other = 'other',
}
registerEnumType(TaskCategory, { name: 'TaskCategory' });

export type TaskDocument = Task & Document;

@ObjectType()
@Schema({ collection: 'tasks', timestamps: true })
export class Task {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true })
  branchId!: string;

  @Field()
  @Prop({ required: true, trim: true })
  title!: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  description?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  assignedToId?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  assignedToName?: string;

  @Field(() => TaskPriority)
  @Prop({ required: true, enum: TaskPriority, default: TaskPriority.low })
  priority!: TaskPriority;

  @Field(() => TaskCategory)
  @Prop({ required: true, enum: TaskCategory, default: TaskCategory.general })
  category!: TaskCategory;

  @Field({ nullable: true })
  @Prop({ default: null })
  dueDate?: Date;

  @Field()
  @Prop({ default: false })
  isCompleted!: boolean;

  @Field({ nullable: true })
  @Prop({ default: null })
  completedBy?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  completedAt?: Date;

  @Field({ nullable: true })
  @Prop({ default: null })
  noteText?: string;

  @Field({ nullable: true })
  @Prop({ default: null })
  photoUri?: string;

  @Field()
  @Prop({ default: true })
  isVisibleToStaff!: boolean;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
