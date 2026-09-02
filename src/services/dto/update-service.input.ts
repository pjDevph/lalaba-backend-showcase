import { InputType, Field, PartialType, OmitType } from '@nestjs/graphql';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateServiceInput } from './create-service.input';

@InputType()
export class UpdateServiceInput extends PartialType(
  OmitType(CreateServiceInput, ['branchId'] as const),
) {
  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;
}
