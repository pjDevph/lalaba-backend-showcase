import { ObjectType, Field, Int } from '@nestjs/graphql';
import { KycDocument } from '../schemas/kyc-document.schema';

// A queue row is the document plus the provider identity a reviewer needs to
// do their job. providerId alone is a bare ObjectId — useless in a review UI.
// Resolved at read time rather than denormalized onto the document so a
// renamed branch shows its current name.
@ObjectType()
export class KycReviewQueueItem {
  @Field(() => KycDocument)
  document!: KycDocument;

  // Branch name or washer display name. Null if the provider has since been
  // deleted — the row still lists so the document can be dismissed.
  @Field(() => String, { nullable: true })
  providerName?: string | null;

  @Field(() => String, { nullable: true })
  ownerEmail?: string | null;

  // Email of the reviewer currently holding the claim. Same argument as
  // providerName: claimedByUid alone is a bare uid, so a reviewer deciding
  // whether to override someone else's claim has nothing to go on. Null when
  // unclaimed, or when the claiming account has since been deleted.
  @Field(() => String, { nullable: true })
  claimedByEmail?: string | null;
}

@ObjectType()
export class PaginatedKycReviewQueue {
  @Field(() => [KycReviewQueueItem]) data!: KycReviewQueueItem[];
  @Field(() => Int) total!: number;
  @Field(() => Int) limit!: number;
  @Field(() => Int) offset!: number;
}
