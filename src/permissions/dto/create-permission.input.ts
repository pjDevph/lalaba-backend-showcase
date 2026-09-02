import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class CreatePermissionInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  permissionName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.MEDIUM)
  description!: string;
}
