import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { TEXT_LIMITS } from '../../common/validators/text-limits';
import { Type } from 'class-transformer';

// Explicit GraphQL name to avoid colliding with the register-user AddressInput.
@InputType('CustomerAddressInput')
class AddressInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  unit?: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  regionName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  provinceName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  cityMunicipalityName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  barangayName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  streetAddress!: string;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  zipCode?: string;
}

// Explicit GraphQL name to avoid colliding with the branches MapLocationInput.
@InputType('CustomerMapLocationInput')
class MapLocationInput {
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Field(() => Float)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Field(() => Float)
  longitude!: number;
}

@InputType()
export class CreateAddressInput {
  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  label?: string;

  @ValidateNested()
  @Type(() => AddressInput)
  @Field(() => AddressInput)
  address!: AddressInput;

  @ValidateNested()
  @Type(() => MapLocationInput)
  @Field(() => MapLocationInput)
  mapLocation!: MapLocationInput;

  @IsOptional()
  @IsString()
  @Field({ nullable: true })
  @MaxLength(TEXT_LIMITS.MEDIUM)
  accessInstructions?: string;

  @IsOptional()
  @Field({ nullable: true, defaultValue: false })
  isDefault?: boolean;
}
