import { InputType, Field } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  NAME_RE,
  NAME_INVALID_MESSAGE,
} from '../../common/validators/name.validator';
import { BranchAccessInput } from './branch-access.input';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

@InputType()
export class UpdateStaffInput {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `firstName ${NAME_INVALID_MESSAGE}` })
  @Field({ nullable: true })
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `lastName ${NAME_INVALID_MESSAGE}` })
  @Field({ nullable: true })
  lastName?: string;

  @IsOptional()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  @Field({ nullable: true })
  phoneNumber?: string;

  // Authoritative when present. See StaffService.resolveGrantEntries for how
  // this composes with the two legacy fields below.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BranchAccessInput)
  @Field(() => [BranchAccessInput], { nullable: true })
  branchAccess?: BranchAccessInput[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true })
  branchIds?: string[];

  /** @deprecated Account-global grants. Send branchAccess instead. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], {
    nullable: true,
    deprecationReason:
      'Grants are per branch now — send branchAccess. Applying this list to every branch is a compatibility shim for app versions shipped before the rollout.',
  })
  permissionIds?: string[];

  @IsOptional()
  @IsBoolean()
  @Field({ nullable: true })
  isActive?: boolean;
}
