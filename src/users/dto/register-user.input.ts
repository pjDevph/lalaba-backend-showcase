import { InputType, Field } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NAME_RE,
  NAME_INVALID_MESSAGE,
} from '../../common/validators/name.validator';
import { ConsentInput } from '../../consents/dto/consent.input';

@InputType()
class AddressInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  unit?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  streetAddress?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  barangayName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  barangayCode?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  cityMunicipalityName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  cityMunicipalityCode?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  provinceName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  provinceCode?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  regionName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  regionCode?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  zipCode?: string;
}

@InputType()
export class RegisterUserInput {
  // Removed uid and email fields since they are now extracted from the Authorization Header token!

  @Field(() => String, {
    description: 'The Mongoose ObjectId reference string for the assigned role',
  })
  @IsNotEmpty()
  @IsString()
  role!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  @Matches(NAME_RE, { message: `firstName ${NAME_INVALID_MESSAGE}` })
  firstName!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  @Matches(NAME_RE, { message: `lastName ${NAME_INVALID_MESSAGE}` })
  lastName!: string;

  @Field(() => String)
  @IsNotEmpty()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  phoneNumber!: string;

  @Field(() => AddressInput, { nullable: true })
  @IsOptional()
  homeAddress?: AddressInput;

  @Field(() => [String], { defaultValue: [] })
  @IsOptional()
  @IsArray()
  registeredDevices?: string[];

  @Field(() => Boolean, { defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => [ConsentInput], {
    description:
      'Policy acceptances captured at registration (ToS/Privacy for every role; ' +
      'plus Merchant Agreement/fee schedule/SLA for merchant and washer).',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsentInput)
  consents!: ConsentInput[];
}
