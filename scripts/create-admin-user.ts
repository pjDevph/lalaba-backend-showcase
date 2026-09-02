// Bootstrap the FIRST admin account.
//
// Every later admin/support account is created from the admin panel
// (createAdminUser), but that mutation is @Roles('admin') — so the first one
// can't come from there. This script is the way in.
//
// Unlike createAdminUser it sets a password directly instead of emailing a
// reset link: against the Auth Emulator no mail is delivered, and a
// chicken-and-egg bootstrap shouldn't depend on inbox access.
//
// Usage:
//   npx ts-node scripts/create-admin-user.ts <email> <password> [firstName] [lastName] [phone]
//   npx ts-node scripts/create-admin-user.ts admin@lalaba.test 'Str0ng!Pass' Prince Gandollas 09171234567
//
// Re-running with the same email resets that account's password and re-asserts
// the admin role — handy when you forget it.
//
// Reads .env for MONGODB_ONLINE / MONGODB_URI_* / FIREBASE_CREDENTIALS_PATH /
// FIREBASE_AUTH_EMULATOR_HOST, exactly as the app does. Point it at whichever
// database you intend to log into: with MONGODB_ONLINE=off that's local Mongo,
// and the account will NOT exist in Atlas.

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as admin from 'firebase-admin';
import mongoose from 'mongoose';

dotenv.config();

const ADMIN_ROLE_ID = 'admin';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set in .env`);
  return value;
}

function resolveMongoUri(): { uri: string; mode: string } {
  const online =
    (process.env.MONGODB_ONLINE ?? '').trim().toLowerCase() === 'on';
  return {
    uri: requireEnv(online ? 'MONGODB_URI_ONLINE' : 'MONGODB_URI_LOCAL'),
    mode: online ? 'online (Atlas)' : 'local',
  };
}

function initFirebase(): void {
  const json = process.env.FIREBASE_CREDENTIALS_JSON;
  const credentialsPath =
    process.env.FIREBASE_CREDENTIALS_PATH_ONLINE ??
    process.env.FIREBASE_CREDENTIALS_PATH;

  let serviceAccount: admin.ServiceAccount;
  if (json) {
    serviceAccount = JSON.parse(json) as admin.ServiceAccount;
  } else if (credentialsPath) {
    const resolved = path.resolve(process.cwd(), credentialsPath);
    serviceAccount = JSON.parse(
      fs.readFileSync(resolved, 'utf8'),
    ) as admin.ServiceAccount;
  } else {
    throw new Error(
      'Missing Firebase credentials: set FIREBASE_CREDENTIALS_JSON or FIREBASE_CREDENTIALS_PATH.',
    );
  }

  // firebase-admin routes Auth to the emulator purely off this env var, which
  // dotenv has already loaded — no extra wiring needed here.
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

async function main() {
  const [email, password, firstName, lastName, phoneNumber] =
    process.argv.slice(2);

  if (!email || !password) {
    throw new Error(
      'Usage: npx ts-node scripts/create-admin-user.ts <email> <password> [firstName] [lastName] [phone]',
    );
  }
  if (password.length < 6) {
    throw new Error('Firebase requires a password of at least 6 characters.');
  }

  const { uri, mode } = resolveMongoUri();
  const emulatorHost = (process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '').trim();

  console.log(`Mongo:    ${mode}`);
  console.log(
    `Auth:     ${emulatorHost ? `emulator (${emulatorHost})` : 'real Firebase'}`,
  );

  initFirebase();
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  // Roles are seeded by RolesService on application bootstrap. If the admin
  // role is missing, the API has never successfully started against this DB.
  const role = await db.collection('roles').findOne({ roleId: ADMIN_ROLE_ID });
  if (!role) {
    throw new Error(
      `No '${ADMIN_ROLE_ID}' role in this database. Start the API once against it (npm run start:dev) so RolesService seeds the roles, then re-run.`,
    );
  }

  // ── Firebase user ──────────────────────────────────────────────────────
  const auth = admin.auth();
  let uid: string;
  let created: boolean;
  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    created = false;
    await auth.updateUser(uid, { password, disabled: false });
    console.log(`Firebase: existing user ${uid} — password reset.`);
  } catch (err: any) {
    if (err?.code !== 'auth/user-not-found') throw err;
    const user = await auth.createUser({
      email,
      password,
      displayName: `${firstName ?? 'Lalaba'} ${lastName ?? 'Admin'}`,
      emailVerified: true,
      disabled: false,
    });
    uid = user.uid;
    created = true;
    console.log(`Firebase: created user ${uid}.`);
  }

  // ── Mongo user document ────────────────────────────────────────────────
  // _id IS the Firebase uid — that's the join the auth guard relies on.
  const users = db.collection('users');
  const clash = await users.findOne({ email, _id: { $ne: uid } as any });
  if (clash) {
    // A clash is usually an ORPHAN: the Auth Emulator's accounts live in
    // .firebase-emulator-data and can be wiped or restored independently of
    // Mongo, which strands the user document on a uid that no longer
    // authenticates. Such a document can never be logged into, so adopting the
    // email is safe and keeps this bootstrap re-runnable — which is its whole
    // purpose. A clash whose uid DOES still resolve is a real ambiguity
    // (two live accounts, one email) and stays a hard stop for a human.
    let clashLives = true;
    try {
      await auth.getUser(String(clash._id));
    } catch (err: any) {
      if (err?.code === 'auth/user-not-found') clashLives = false;
      else throw err;
    }

    if (clashLives) {
      throw new Error(
        `A different user document already owns ${email} (_id ${String(clash._id)}), and that uid still has a live Firebase account. Resolve that before re-running.`,
      );
    }

    await users.deleteOne({ _id: clash._id });
    console.log(
      `Mongo: removed orphaned user document ${String(clash._id)} (no Firebase account) so ${email} could be re-linked.`,
    );
  }

  const now = new Date();
  await users.updateOne(
    { _id: uid as any },
    {
      $set: {
        email,
        firstName: firstName ?? 'Lalaba',
        lastName: lastName ?? 'Admin',
        phoneNumber: phoneNumber ?? '09000000000',
        role: role._id,
        isActive: true,
        isArchived: false,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  console.log(
    created
      ? `\n✅ Admin account created — sign in at the panel with ${email}.`
      : `\n✅ Admin account updated — sign in at the panel with ${email}.`,
  );
  console.log(`   uid: ${uid}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
