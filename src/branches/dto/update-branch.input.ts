import { InputType, PartialType } from '@nestjs/graphql';
import { CreateBranchInput } from './create-branch.input';

@InputType()
export class UpdateBranchInput extends PartialType(CreateBranchInput) {}
