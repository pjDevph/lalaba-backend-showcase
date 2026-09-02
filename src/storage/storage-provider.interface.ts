export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

// Signed read URLs for private evidence are short-lived by design — long
// enough for a reviewer/owner to open the document, short enough that a
// leaked URL is useless minutes later.
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 300;

export interface StorageProvider {
  /** Public upload (branding media) — returns a publicly readable URL. */
  upload(buffer: Buffer, key: string, contentType: string): Promise<string>;

  /**
   * Private upload (KYC/evidence) — the object must NOT be anonymously
   * readable. Returns the storage object key (never a public URL); reads go
   * through getSignedReadUrl.
   */
  uploadPrivate(
    buffer: Buffer,
    key: string,
    contentType: string,
  ): Promise<string>;

  /** Short-lived signed read URL for a private object. */
  getSignedReadUrl(objectKey: string, expirySeconds?: number): Promise<string>;

  /**
   * Permanently remove a PUBLIC object by the key it was uploaded with.
   *
   * Public-only, mirroring the `upload`/`uploadPrivate` naming above. Private
   * evidence lives in the same bucket behind the `private-evidence/` prefix and
   * has no delete path today; it deliberately gains none here, because erasing
   * reviewed KYC evidence is a decision with retention consequences rather than
   * a cleanup detail. Add `deletePrivate` when something actually needs it.
   *
   * Idempotent: a missing object resolves rather than throwing, so callers can
   * delete without checking existence first and a retried revoke is safe.
   *
   * This exists because nulling a DB pointer is not erasure — a revoked courier
   * selfie or an erased account must not stay readable at its permanent public
   * URL just because the field was set to null.
   */
  delete(objectKey: string): Promise<void>;
}
