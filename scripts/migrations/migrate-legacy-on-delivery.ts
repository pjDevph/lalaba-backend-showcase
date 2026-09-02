// Migration: rewrite pre-hardening online_orders that still carry the removed
// ON_DELIVERY payment contract (GAP-P0-028).
//
//   paymentTiming 'on_delivery'        → 'on_pickup'
//   paymentStatus 'to_pay_on_delivery' → 'unpaid'
//
// Usage:
//   npx ts-node scripts/migrations/migrate-legacy-on-delivery.ts          # dry run
//   npx ts-node scripts/migrations/migrate-legacy-on-delivery.ts --apply  # write
//
// Requires MONGODB_URI. Safe to re-run: the filter only matches the legacy
// values, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { migrateLegacyOnDelivery } from '../../src/migrations/legacy-on-delivery.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await migrateLegacyOnDelivery({
    connection: mongoose.connection,
    apply,
    log: (m) => console.log(m),
  });

  console.log(
    apply
      ? `Applied: paymentTiming rewritten on ${result.paymentTimingUpdated} order(s), paymentStatus on ${result.paymentStatusUpdated}.`
      : `Dry run: ${result.paymentTimingMatched} order(s) carry paymentTiming 'on_delivery' and ${result.paymentStatusMatched} carry paymentStatus 'to_pay_on_delivery'. Re-run with --apply to rewrite.`,
  );
  console.log(
    `Affected order ids (${result.affectedOrderIds.length}): ${result.affectedOrderIds.join(', ') || '(none)'}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
