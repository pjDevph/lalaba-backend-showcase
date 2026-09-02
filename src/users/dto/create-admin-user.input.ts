import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, IsIn, IsNotEmpty, IsString, Matches } from 'class-validator';
import {
  NAME_RE,
  NAME_INVALID_MESSAGE,
} from '../../common/validators/name.validator';

@InputType()
export class CreateAdminUserInput {
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

  // roleId, not a Mongo ObjectId — this mutation must never trust an
  // arbitrary client-supplied role reference, only these two values.
  @IsIn(['admin', 'support'])
  @Field()
  role!: string;
}
