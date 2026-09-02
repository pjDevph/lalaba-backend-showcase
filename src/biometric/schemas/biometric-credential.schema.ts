import { ObjectType, Field, ID } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BiometricCredentialDocument = BiometricCredential & Document;

/**
 * A device-bound biometric credential (WebAuthn/passkey-style).
 *
 * The device generates an asymmetric keypair in secure hardware (iOS Secure
 * Enclave / Android Keystore/StrongBox) whose PRIVATE key is gated by Face ID /
 * fingerprint and never leaves the device. Only the PUBLIC key is registered
 * here. No biometric data and no secret is ever stored server-side — login is
 * proven by verifying a signature over a one-time challenge against `publicKey`.
 */
@ObjectType()
@Schema({ collection: 'biometric_credentials', timestamps: true })
export class BiometricCredential {
  @Field(() => ID)
  _id!: string;

  // Firebase uid == User._id (see users/schemas/user.schema.ts).
  @Prop({ type: String, ref: 'User', required: true })
  uid!: string;

  @Field()
  @Prop({ required: true })
  deviceId!: string;

  @Field()
  @Prop({ required: true, trim: true })
  deviceName!: string;

  @Field()
  @Prop({ required: true, enum: ['ios', 'android'] })
  platform!: string;

  // Base64 SPKI (DER) RSA-2048 public key produced by react-native-biometrics.
  // NOT exposed over GraphQL (@Prop only, no @Field) — no need to ship it back.
  @Prop({ required: true })
  publicKey!: string;

  @Prop({ required: true, default: 'SHA256withRSA' })
  algorithm!: string;

  @Field(() => Date, { nullable: true })
  @Prop({ type: Date, default: null })
  lastUsedAt?: Date | null;

  @Field()
  @Prop({ type: Boolean, default: false })
  disabled!: boolean;

  @Field(() => Date, { nullable: true })
  createdAt?: Date;

  @Field(() => Date, { nullable: true })
  updatedAt?: Date;
}

export const BiometricCredentialSchema =
  SchemaFactory.createForClass(BiometricCredential);

// One credential per (user, device). Re-enrolment on the same device upserts
// this same document (keeping a stable _id / credentialId for the client).
BiometricCredentialSchema.index({ uid: 1, deviceId: 1 }, { unique: true });
