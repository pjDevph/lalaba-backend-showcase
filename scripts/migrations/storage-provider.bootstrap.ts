// Shared helper for migration scripts that need the app's StorageProvider
// outside a Nest application context.
//
// Bootstrapping the full AppModule just to copy objects would pull in Mongo,
// GraphQL and the scheduler. FirebaseStorageProvider's only dependency is
// FirebaseService, whose only dependency is ConfigService, and
// `new ConfigService()` reads process.env — so we construct exactly what the
// app would have and nothing else.
//
// This follows whichever bucket the environment points at: the Storage Emulator
// when FIREBASE_STORAGE_EMULATOR_HOST is set (local), the real bucket otherwise.
// FirebaseService.onModuleInit exports STORAGE_EMULATOR_HOST before
// initializeApp, which is what makes that switch take effect.

import { ConfigService } from '@nestjs/config';
import { FirebaseStorageProvider } from '../../src/storage/firebase-storage.provider';
import { FirebaseService } from '../../src/firebase/firebase.service';
import type { StorageProvider } from '../../src/storage/storage-provider.interface';

export async function buildStorageProvider(): Promise<StorageProvider> {
  const config = new ConfigService();
  const firebase = new FirebaseService(config);
  firebase.onModuleInit();
  return Promise.resolve(new FirebaseStorageProvider(firebase));
}
