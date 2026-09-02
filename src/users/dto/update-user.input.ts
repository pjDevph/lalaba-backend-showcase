import { InputType, Field } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NAME_RE,
  NAME_INVALID_MESSAGE,
} from '../../common/validators/name.validator';

@InputType()
class UpdateAddressInput {
  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  unit?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  streetAddress?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  barangayName?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  barangayCode?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  cityMunicipalityName?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  cityMunicipalityCode?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  provinceName?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  provinceCode?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  regionName?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  regionCode?: string;

  @IsOptional()
  @IsString()
  @Field(() => String, { nullable: true })
  zipCode?: string;
}

@InputType()
export class UpdateUserInput {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `firstName ${NAME_INVALID_MESSAGE}` })
  @Field(() => String, { nullable: true })
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_RE, { message: `lastName ${NAME_INVALID_MESSAGE}` })
  @Field(() => String, { nullable: true })
  lastName?: string;

  @IsOptional()
  @Matches(/^09\d{9}$/, {
    message: 'phoneNumber must be a valid PH mobile number (09XXXXXXXXX)',
  })
  @Field(() => String, { nullable: true })
  phoneNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAddressInput)
  @Field(() => UpdateAddressInput, { nullable: true })
  homeAddress?: UpdateAddressInput;
}
