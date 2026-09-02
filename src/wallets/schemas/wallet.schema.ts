import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WalletDocument = Wallet & Document;

// Prepaid/consumable, not an earnings account — no withdrawals, ever (§17).
// One per branchId, which already uniformly covers both Merchant branches
// and a Washer's own anchor branch — no separate per-washer wallet concept
// needed on top of that.
@ObjectType()
@Schema({ collection: 'wallets', timestamps: true })
export class Wallet {
  @Field(() => ID)
  _id!: string;

  @Field()
  @Prop({ type: String, ref: 'Branch', required: true, unique: true })
  branchId!: string;

  @Field(() => Int)
  @Prop({ type: Number, default: 0 })
  balanceCentavos!: number;

  // Set the first time a top-up brings the balance to the ₱1,000 onboarding
  // minimum. Once set, the account is "activated" — thereafter it only needs to
  // keep the ₱100 accept-a-booking minimum, not re-onboard.
  @Field({ nullable: true })
  @Prop({ type: Date, default: null })
  activatedAt?: Date;

  @Field({ nullable: true })
  createdAt?: Date;

  @Field({ nullable: true })
  updatedAt?: Date;
}

export const WalletSchema = SchemaFactory.createForClass(Wallet);
