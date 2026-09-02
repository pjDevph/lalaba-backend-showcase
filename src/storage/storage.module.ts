import { Module } from '@nestjs/common';
import { FirebaseModule } from '../firebase/firebase.module';
import { FirebaseStorageProvider } from './firebase-storage.provider';
import { STORAGE_PROVIDER } from './storage-provider.interface';

/**
 * One storage backend everywhere: Firebase Storage.
 *
 * Local dev used to run Docker MinIO behind a STORAGE_ONLINE switch, which meant
 * the code path exercised locally was not the code path that shipped — and it
 * broke in a way that only showed up locally: MinIO minted presigned URLs
 * against MINIO_ENDPOINT while public media used MINIO_PUBLIC_URL, so the two
 * pointed at different hosts by construction and the admin panel's document
 * preview resolved to a host the browser could not reach.
 *
 * Local now points the same FirebaseStorageProvider at the Storage Emulator via
 * FIREBASE_STORAGE_EMULATOR_HOST (see scripts/set-mode.sh), so local and
 * production differ only in which host serves the bucket.
 */
@Module({
  imports: [FirebaseModule],
  providers: [
    FirebaseStorageProvider,
    { provide: STORAGE_PROVIDER, useExisting: FirebaseStorageProvider },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
