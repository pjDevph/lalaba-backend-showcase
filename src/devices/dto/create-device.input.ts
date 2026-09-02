import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class CreateDeviceInput {
  @IsString()
  @IsNotEmpty()
  @Field()
  deviceName!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  operatingSystem!: string;

  @IsString()
  @IsNotEmpty()
  @Field()
  fcmToken!: string;

  // The branch this device is being registered to.
  @IsString()
  @IsNotEmpty()
  @Field()
  branchId!: string;

  // Marketing device model, e.g. "iPhone 14" (optional; owner devices may omit).
  @IsString()
  @IsOptional()
  @Field({ nullable: true })
  deviceModel?: string;
}
