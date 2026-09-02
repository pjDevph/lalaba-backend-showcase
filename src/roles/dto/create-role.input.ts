import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';

@InputType()
export class CreateRoleInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  roleId!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  roleName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  @MaxLength(TEXT_LIMITS.MEDIUM)
  description!: string;
}
