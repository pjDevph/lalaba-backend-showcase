import { InputType, PartialType, OmitType } from '@nestjs/graphql';
import { CreateRoleInput } from './create-role.input';

@InputType()
export class UpdateRoleInput extends PartialType(
  OmitType(CreateRoleInput, ['roleId'] as const),
) {}
