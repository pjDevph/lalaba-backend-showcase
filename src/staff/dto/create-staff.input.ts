import { InputType, Field, registerEnumType } from '@nestjs/graphql';
import {
  IsArray,
  IsEmail,
  IsEnum,
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

// The only roles an owner may invite someone into — never 'merchant',
// 'washer', 'admin', etc. (§5 — no self-registration into privileged roles).
export enum InvitableStaffRole {
  STAFF = 'staff',
  COURIER = 'courier',
}
registerEnumType(InvitableStaffRole, { name: 'InvitableStaffRole' });

@InputType()
export class CreateStaffInput {
  @IsEmail({}, { message: 'Must be a valid email address' })
  @Field()
  email!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `firstName ${NAME_INVALID_MESSAGE}` })
  @Field()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `lastName ${NAME_INVALID_MESSAGE}` })
  @Field()
  lastName!: string;

  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  @Field()
  phoneNumber!: string;

  // Branch assignment plus the access granted there, in one call. Before this
  // existed a staff member was created with no permissions at all and the owner
  // had to open a second screen to grant any — which is most of why adding
  // someone felt like a chore.
  //
  // Takes precedence over `branchIds` when both are sent. `branchIds` alone
  // still means "assign, grant nothing", which is exactly right for a courier.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BranchAccessInput)
  @Field(() => [BranchAccessInput], { nullable: true })
  branchAccess?: BranchAccessInput[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Field(() => [String], { nullable: true, defaultValue: [] })
  branchIds?: string[];

  @IsOptional()
  @IsEnum(InvitableStaffRole)
  @Field(() => InvitableStaffRole, {
    nullable: true,
    defaultValue: InvitableStaffRole.STAFF,
  })
  role?: InvitableStaffRole;
}
