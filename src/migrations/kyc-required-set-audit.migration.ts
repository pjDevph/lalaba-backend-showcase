import type { Connection } from 'mongoose';
import {
  KycDocumentStatus,
  KycDocumentType,
  KycProviderType,
  REQUIRED_KYC_DOCUMENT_TYPES,
} from '../kyc/schemas/kyc-document.schema';

// ---------------------------------------------------------------------------
// The verification requirement sets widened when the partner verification UI
// was built: merchants now need DTI, BIR 2303 and three storefront photos
// instead of a business permit, and washers need an ID back and proof of
// address. Every provider verified under the OLD set therefore has documents
// it has never submitted.
//
// The product decision is GRANDFATHERING: those providers keep their badge.
// This script exists to make that population visible, not to change it.
//
// It NEVER downgrades verificationStatus. Revoking a live provider's badge is
// a customer-visible regression, and the whole point of grandfathering is that
// it does not happen. --apply only stamps `grandfatheredAt`, which the apps use
// to show "you're verified; new documents will be needed at your next review"
// instead of implying the badge is at risk.
//
// No data backfill is needed for the new contract itself: expiresAt is
// nullable, the new document types simply have no rows yet, and BUSINESS_PERMIT
// stays on the submission allowlist so permits already in the review queue
// remain approvable.
//
// Idempotency: --apply only stamps providers that lack the field, so a second
// run reports the same population and writes nothing.
// ---------------------------------------------------------------------------

export interface GrandfatheredProvider {
  providerType: KycProviderType;
  providerId: string;
  name: string;
  /** Required types with no APPROVED document — what a re-review would ask for. */
  missingDocumentTypes: KycDocumentType[];
}

export interface KycRequiredSetAuditResult {
  /** APPROVED providers that no longer satisfy the current required set. */
  grandfathered: GrandfatheredProvider[];
  /** Newly stamped with grandfatheredAt (0 on a dry run). */
  stamped: number;
  /**
   * BUSINESS_PERMIT documents still awaiting review. Expected to drain
   * normally — the type stays submittable and approvable — but worth surfacing
   * so nobody assumes retiring it stranded them.
   */
  pendingLegacyPermits: number;
}

export interface KycRequiredSetAuditOptions {
  connection: Connection;
  /** false ⇒ dry run: report only, write nothing. */
  apply: boolean;
  log?: (message: string) => void;
}

export async function auditKycRequiredSet(
  options: KycRequiredSetAuditOptions,
): Promise<KycRequiredSetAuditResult> {
  const { connection, apply, log = () => undefined } = options;
  const documents = connection.collection('kyc_documents');
  const branches = connection.collection('branches');
  const washers = connection.collection('washer_profiles');

  const result: KycRequiredSetAuditResult = {
    grandfathered: [],
    stamped: 0,
    pendingLegacyPermits: await documents.countDocuments({
      documentType: KycDocumentType.BUSINESS_PERMIT,
      status: {
        $in: [KycDocumentStatus.SUBMITTED, KycDocumentStatus.UNDER_REVIEW],
      },
    }),
  };

  const sources = [
    {
      providerType: KycProviderType.MERCHANT_BRANCH,
      collection: branches,
      nameField: 'branchName',
    },
    {
      providerType: KycProviderType.WASHER,
      collection: washers,
      nameField: 'displayName',
    },
  ] as const;

  for (const source of sources) {
    const required = REQUIRED_KYC_DOCUMENT_TYPES[source.providerType];
    const approved = await source.collection
      .find(
        { verificationStatus: 'APPROVED' },
        { projection: { [source.nameField]: 1, grandfatheredAt: 1 } },
      )
      .toArray();

    for (const provider of approved) {
      const providerId = String(provider._id);
      // Which required types this provider actually has approved. Read live
      // rather than trusting verificationStatus, which is exactly what the old
      // set granted.
      const approvedTypes = await documents.distinct('documentType', {
        providerId,
        status: KycDocumentStatus.APPROVED,
      });
      const missing = required.filter(
        (type) => !approvedTypes.includes(type as string),
      );
      if (missing.length === 0) continue;

      const name = String(provider[source.nameField] ?? '(unnamed)');
      result.grandfathered.push({
        providerType: source.providerType,
        providerId,
        name,
        missingDocumentTypes: missing,
      });
      log(
        `${source.providerType} ${providerId} (${name}) is APPROVED but missing: ${missing.join(', ')}`,
      );

      if (apply && provider.grandfatheredAt == null) {
        await source.collection.updateOne(
          { _id: provider._id },
          { $set: { grandfatheredAt: new Date() } },
        );
        result.stamped += 1;
      }
    }
  }

  return result;
}
