// Migration: backfill User.branchAccess for staff and couriers.
//
// Staff permissions are granted per branch now. A staff document with no
// `branchAccess` holds nothing anywhere, so this must run BEFORE the code
// deploy — it only writes the new field and widens the derived union, which the
// old build already grants implicitly, so it is safe against the running
// version.
//
// Each staff member's existing grants are copied onto every branch they are
// assigned to, plus the three permissions the old implicit floor gave them for
// free (order_confirm_pickup, order_update_status, inventory_edit). By default
// grants are then widened to whole permission groups so the four-switch UI
// tells the truth; the dry run prints exactly who gains what.
// See src/migrations/branch-access-backfill.migration.ts.
//
// Usage:
//   npx ts-node scripts/migrations/backfill-branch-access.ts           # dry run
//   npx ts-node scripts/migrations/backfill-branch-access.ts --apply   # write
//   npx ts-node scripts/migrations/backfill-branch-access.ts --exact   # no widening
//
// Requires MONGODB_URI. Safe to re-run: only documents with no `branchAccess`
// are matched, so the second run reports 0.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { backfillBranchAccess } from '../../src/migrations/branch-access-backfill.migration';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const exact = process.argv.includes('--exact');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);

  const result = await backfillBranchAccess({
    connection: mongoose.connection,
    apply,
    exact,
    log: (m) => console.log(m),
  });

  console.log('');
  if (apply) {
    console.log(
      `Applied: branchAccess written on ${result.updated} account(s).`,
    );
  } else {
    const gaining = result.rows.filter((r) => r.gained.length).length;
    console.log(
      `Dry run: ${result.matched} account(s) need branchAccess; ` +
        `${gaining} would gain permissions through group expansion.`,
    );
    console.log('Re-run with --apply to write, or --exact to widen nothing.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
