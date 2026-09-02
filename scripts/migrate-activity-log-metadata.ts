// One-off migration: stringify ActivityLog.metadata values that were saved
// as raw objects before the metadata field was changed to a String type.
// Usage: npx ts-node scripts/migrate-activity-log-metadata.ts [--apply]
// Without --apply it only reports how many documents would change.

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  await mongoose.connect(uri);
  const collection = mongoose.connection.collection('activity_logs');

  const cursor = collection.find({
    metadata: { $type: 'object' },
  });

  let count = 0;
  let updated = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;
    count++;
    const stringified = JSON.stringify(doc.metadata);
    if (apply) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { metadata: stringified } },
      );
      updated++;
    }
  }

  console.log(
    apply
      ? `Updated ${updated} activity_logs documents.`
      : `Dry run: ${count} activity_logs documents have object metadata and would be updated. Re-run with --apply to write.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
