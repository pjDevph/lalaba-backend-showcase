import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { TaskPriority, TaskCategory } from '../schemas/task.schema';

@InputType()
export class UpdateTaskInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'title must be at most 100 characters' })
  title?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'description must be at most 500 characters' })
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  assignedToName?: string;

  @Field(() => TaskPriority, { nullable: true })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @Field(() => TaskCategory, { nullable: true })
  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isVisibleToStaff?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'completedBy must be at most 100 characters' })
  completedBy?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'noteText must be at most 500 characters' })
  noteText?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  photoUri?: string;
}
