import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { InventoryCategory } from '../../inventory/schemas/inventory.schema';

@InputType()
export class SetServiceProductDefaultInput {
  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  serviceTemplateId!: string;

  @IsEnum(InventoryCategory)
  @Field(() => InventoryCategory)
  category!: InventoryCategory;

  @IsString()
  @IsNotEmpty()
  @Field(() => ID)
  productId!: string;
}
