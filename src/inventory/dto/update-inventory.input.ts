import { InputType, PartialType, OmitType } from '@nestjs/graphql';
import { CreateInventoryInput } from './create-inventory.input';

@InputType()
export class UpdateInventoryInput extends PartialType(
  OmitType(CreateInventoryInput, ['branchId', 'stockQuantity'] as const),
) {}
