import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';

// uploadMedia is the PUBLIC branding path only (logos, cover photos, product
// shots, profile avatars). The caller may pick a folder, but only from this
// allowlist of public branding roots — KYC/evidence uploads must never land
// here (they go through submitKycDocument, which derives its own private
// storage path server-side). Checked against the FIRST path segment.
export const PUBLIC_MEDIA_FOLDER_ALLOWLIST = [
  'branding',
  'branches',
  'washers',
  'products',
  'profiles',
  'uploads',
] as const;

/**
 * SEC-006 — magic-byte signatures for every MIME type uploadMedia accepts.
 *
 * A declared MIME type is a client assertion; these are the bytes the file
 * actually starts with. Each entry returns true only when the buffer really is
 * that format. Keep in lockstep with the extension map in `getExtension`: a
 * type that has an extension but no matcher would be unvalidatable.
 */
const MIME_SIGNATURE_MATCHERS: Record<string, (b: Buffer) => boolean> = {
  // FF D8 FF
  'image/jpeg': (b) =>
    b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/jpg': (b) =>
    b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // 89 50 4E 47 0D 0A 1A 0A
  'image/png': (b) =>
    b.length >= 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  // "GIF87a" / "GIF89a"
  'image/gif': (b) =>
    b.length >= 6 &&
    (b.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      b.subarray(0, 6).toString('latin1') === 'GIF89a'),
  // "RIFF" .... "WEBP"
  'image/webp': (b) =>
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  // ISO-BMFF box: "ftyp" at offset 4
  'video/mp4': (b) =>
    b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  // "%PDF-"
  'application/pdf': (b) =>
    b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
};

export function assertContentMatchesMimeType(
  buffer: Buffer,
  mimeType: string,
): void {
  const matcher = MIME_SIGNATURE_MATCHERS[mimeType];
  // Fail closed: an accepted MIME type with no matcher is a bug, not a pass.
  if (!matcher || !matcher(buffer)) {
    throw new BadRequestException(
      'The uploaded file does not match its declared file type.',
    );
  }
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
  ) {}

  async uploadBase64(
    base64: string,
    mimeType: string,
    folder: string,
  ): Promise<string> {
    // FIX 1 — Folder path traversal
    if (!folder || typeof folder !== 'string') {
      throw new BadRequestException('Upload destination is required.');
    }
    if (
      folder.includes('..') ||
      folder.startsWith('/') ||
      !/^[a-zA-Z0-9_\-/]+$/.test(folder)
    ) {
      throw new BadRequestException('Invalid upload destination.');
    }

    // Public-branding allowlist (RISK-P0-002): the caller-supplied folder may
    // only target known public branding roots. Anything else — in particular
    // kyc/evidence-looking destinations — is rejected.
    const rootSegment = folder.split('/')[0];
    if (
      !(PUBLIC_MEDIA_FOLDER_ALLOWLIST as readonly string[]).includes(
        rootSegment,
      )
    ) {
      throw new BadRequestException('Invalid upload destination.');
    }

    try {
      const ext = this.getExtension(mimeType);
      const filename = `${folder}/${randomUUID()}.${ext}`;

      // Strip data URI prefix if present (e.g., "data:image/jpeg;base64,...")
      const data = base64.includes(',') ? base64.split(',')[1] : base64;

      // FIX 3 — Base64 validation
      if (!data || data.length === 0) {
        throw new BadRequestException('No file was provided.');
      }
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) {
        throw new BadRequestException(
          'The uploaded file is corrupted or invalid.',
        );
      }
      // Max ~5 MB (base64 is ~1.33x binary size)
      if (data.length > 7 * 1024 * 1024) {
        throw new BadRequestException('File exceeds the 5 MB size limit');
      }

      const buffer = Buffer.from(data, 'base64');

      // SEC-006 — content sniffing. Until now the stored extension came purely
      // from the client-declared MIME type, so `mimeType: 'image/png'` on an
      // HTML/SVG/script payload wrote attacker-controlled content to the
      // public origin under a .png name. Reject anything whose real leading
      // bytes disagree with what the caller claims it is.
      assertContentMatchesMimeType(buffer, mimeType);

      const url = await this.storageProvider.upload(buffer, filename, mimeType);
      this.logger.log(`Uploaded media: ${filename}`);
      return url;
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error('Media upload failed', err?.message);
      throw new InternalServerErrorException('Media upload failed');
    }
  }

  // FIX 2 — MIME type validation (block unsupported types)
  private getExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
    };
    const ext = map[mimeType];
    if (!ext) {
      throw new BadRequestException(
        'File type not supported. Please upload an image.',
      );
    }
    return ext;
  }
}
