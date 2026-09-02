// Audit: which already-verified providers no longer satisfy the widened KYC
// requirement sets (DTI / BIR 2303 / business photos for merchants, ID back
// and proof of address for washers).
//
// These providers are GRANDFATHERED — they keep their badge. This script only
// makes the population visible; --apply stamps `grandfatheredAt` so the apps
// can explain the situation instead of implying the badge is at risk. It never
// downgrades verificationStatus.
//
// Usage:
//   npx ts-node scripts/migrations/audit-kyc-required-set.ts          # report
//   npx ts-node scripts/migrations/audit-kyc-required-set.ts --apply  # stamp
//
// Requires MONGODB_URI. Safe to re-run: --apply only stamps providers that
// lack the field.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { auditKycRequiredSet } from '../../src/migrations/kyc-required-set-audit.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await auditKycRequiredSet({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    `\n${result.grandfathered.length} verified provider(s) predate the current required set.`,
  );
  console.log(
    apply
      ? `Applied: stamped grandfatheredAt on ${result.stamped}. No badge was changed.`
      : 'Dry run: nothing written. Re-run with --apply to stamp grandfatheredAt.',
  );
  if (result.pendingLegacyPermits > 0) {
    console.log(
      `${result.pendingLegacyPermits} BUSINESS_PERMIT document(s) are still awaiting review. They remain approvable — the type stays on the submission allowlist.`,
    );
  }

  // CSV on stdout so Ops can pipe it straight to a file.
  if (result.grandfathered.length > 0) {
    console.log('\nproviderType,providerId,name,missingDocumentTypes');
    for (const p of result.grandfathered) {
      const name = p.name.replace(/"/g, '""');
      console.log(
        `${p.providerType},${p.providerId},"${name}","${p.missingDocumentTypes.join(' ')}"`,
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
