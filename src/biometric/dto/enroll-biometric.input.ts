import { InputType, Field } from '@nestjs/graphql';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class EnrollBiometricInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Field()
  deviceId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Field()
  deviceName!: string;

  @IsIn(['ios', 'android'])
  @Field()
  platform!: string;

  // Base64 SPKI public key from react-native-biometrics createKeys().
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  @Field()
  publicKey!: string;
}
