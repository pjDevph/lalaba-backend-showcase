import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import {
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  StorageProvider,
} from './storage-provider.interface';

// Private evidence lives in the same Firebase bucket under this key prefix,
// but is never saved with `public: true` — reads only via getSignedReadUrl.
export const FIREBASE_PRIVATE_PREFIX = 'private-evidence/';

@Injectable()
export class FirebaseStorageProvider implements StorageProvider {
  constructor(private readonly firebaseService: FirebaseService) {}

  /**
   * A readable URL for an object, correct for whichever backend is live.
   *
   * The emulator serves nothing at `storage.googleapis.com`, so the production
   * URL shape is not merely unsigned there — it points at a different host
   * entirely and 404s. Its download endpoint also percent-encodes the whole key
   * (slashes included), which is why `encodeURIComponent` is right here and
   * would be wrong for the GCS path form.
   */
  private publicUrlFor(bucketName: string, objectKey: string): string {
    const emulatorHost = this.firebaseService.getStorageEmulatorHost();
    if (emulatorHost) {
      return `http://${emulatorHost}/v0/b/${bucketName}/o/${encodeURIComponent(
        objectKey,
      )}?alt=media`;
    }
    return `https://storage.googleapis.com/${bucketName}/${objectKey}`;
  }

  async upload(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<string> {
    const bucket = this.firebaseService.getStorageBucket();
    const file = bucket.file(key);
    await file.save(buffer, { metadata: { contentType }, public: true });
    return this.publicUrlFor(bucket.name, key);
  }

  async uploadPrivate(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<string> {
    const bucket = this.firebaseService.getStorageBucket();
    const objectKey = `${FIREBASE_PRIVATE_PREFIX}${key}`;
    const file = bucket.file(objectKey);
    // Deliberately NOT public — no ACL is granted; access is only ever via a
    // short-lived signed URL issued by getSignedReadUrl (RISK-P0-002).
    await file.save(buffer, { metadata: { contentType } });
    return objectKey;
  }

  // Public bucket only — see the interface note. `ignoreNotFound` keeps this
  // idempotent, so a retried revoke never fails on the second pass.
  async delete(objectKey: string): Promise<void> {
    const bucket = this.firebaseService.getStorageBucket();
    await bucket.file(objectKey).delete({ ignoreNotFound: true });
  }

  async getSignedReadUrl(
    objectKey: string,
    expirySeconds: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    const bucket = this.firebaseService.getStorageBucket();

    // LOCAL ONLY. The Storage Emulator does not implement V4 signature
    // verification: getSignedUrl() would mint a storage.googleapis.com URL that
    // points past the emulator at a bucket the local service account may not
    // even reach, so private evidence becomes unopenable in local dev.
    //
    // The honest cost of the workaround: this returns an UNSIGNED, non-expiring
    // URL, so private KYC evidence is NOT access-controlled when running on the
    // emulator. That directly contradicts uploadPrivate's guarantee
    // (RISK-P0-002) and is tolerable only because the emulator is a throwaway
    // local process holding test data. This branch must never be reachable in
    // production — it is gated on FIREBASE_STORAGE_EMULATOR_HOST, which
    // scripts/set-mode.sh clears in online mode.
    const emulatorHost = this.firebaseService.getStorageEmulatorHost();
    if (emulatorHost) {
      return this.publicUrlFor(bucket.name, objectKey);
    }

    const [url] = await bucket.file(objectKey).getSignedUrl({
      action: 'read',
      expires: Date.now() + expirySeconds * 1000,
    });
    return url;
  }
}
