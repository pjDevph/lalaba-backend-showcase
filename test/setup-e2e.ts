/**
 * Per-test-file environment setup, registered as a jest `setupFiles` entry so
 * it runs BEFORE any module import in the spec file.
 *
 * That ordering matters: src/app.module.ts calls `ConfigModule.forRoot()` at
 * decorator-evaluation time, i.e. the moment the file is first imported. Env
 * assigned after that import would be read too late by any provider that
 * captures config in its constructor.
 *
 * Everything here is deliberately explicit rather than inherited from a
 * developer's .env, so an e2e run is reproducible on any machine and in CI.
 */
import { randomBytes } from 'node:crypto';

const base = process.env.E2E_MONGO_BASE_URI;
if (!base) {
  throw new Error(
    'E2E_MONGO_BASE_URI is not set — test/global-setup.ts did not run. ' +
      'Run the suite via `npm run test:e2e` (jest --config ./test/jest-e2e.json).',
  );
}

// Give every spec file its own database inside the shared replica set so one
// suite's seed data can never leak into another's assertions.
const dbName = `e2e_${randomBytes(6).toString('hex')}`;
const [hostPart, queryPart] = base.replace(/^mongodb:\/\//, '').split('?');
const hosts = hostPart.replace(/\/$/, '');
process.env.E2E_MONGO_DB_NAME = dbName;
process.env.MONGODB_URI_LOCAL = `mongodb://${hosts}/${dbName}${
  queryPart ? `?${queryPart}` : ''
}`;

process.env.NODE_ENV = 'test';
process.env.MONGODB_ONLINE = 'off';

// Storage: FirebaseStorageProvider pointed at the Storage Emulator. Nothing is
// uploaded during e2e (no media assertions live here) and the provider opens no
// connection at construction, so boot succeeds whether or not the emulator is
// actually running. The emulator host is set regardless so that if a test ever
// does upload, it cannot reach the real bucket. FIREBASE_STORAGE_BUCKET is set
// below with the rest of the Firebase config.
process.env.FIREBASE_STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? 'localhost:9199';

// Payments: no XENDIT_SECRET_KEY => wallets.module binds DevPaymentGateway
// (allowed because NODE_ENV !== 'production'). The callback token IS set, so
// the webhook auth path is the real one and can be exercised both ways.
delete process.env.XENDIT_SECRET_KEY;
process.env.XENDIT_ONLINE = 'off';
process.env.XENDIT_CALLBACK_TOKEN = 'e2e-callback-token';

// FirebaseService is replaced wholesale in the test app (see e2e-app.ts), so
// no real service-account key is needed; these only keep config lookups sane.
process.env.FIREBASE_STORAGE_BUCKET = 'e2e-bucket.appspot.com';
process.env.FIREBASE_WEB_API_KEY = 'e2e-web-api-key';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
