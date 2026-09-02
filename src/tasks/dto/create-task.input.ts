import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { TaskPriority, TaskCategory } from '../schemas/task.schema';

@InputType()
export class CreateTaskInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  branchId?: string;

  @Field()
  @IsString()
  @MinLength(1, { message: 'title must not be empty' })
  @MaxLength(100, { message: 'title must be at most 100 characters' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title!: string;

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

  @Field(() => TaskPriority, { nullable: true, defaultValue: TaskPriority.low })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @Field(() => TaskCategory, {
    nullable: true,
    defaultValue: TaskCategory.general,
  })
  @IsOptional()
  @IsEnum(TaskCategory)
  category?: TaskCategory;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isVisibleToStaff?: boolean;
}
