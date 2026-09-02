// Jest mock assertions like expect(mock.fn) trip @typescript-eslint/unbound-method
// on plain mocked-interface references — safe here, so disabled for this spec.
/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';
import { STORAGE_PROVIDER } from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';

// Uploads are content-sniffed (SEC-006): the declared MIME type must match the
// file's real magic bytes, so this fixture carries a genuine PNG signature
// rather than arbitrary text.
const PNG_BASE64 = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString(
  'base64',
);

describe('MediaService (unit)', () => {
  let service: MediaService;
  let storageMock: jest.Mocked<StorageProvider>;

  beforeEach(async () => {
    storageMock = {
      upload: jest.fn(async (_b, key, _ct) => `https://public.example/${key}`),
      uploadPrivate: jest.fn(async (_b, key, _ct) => key),
      getSignedReadUrl: jest.fn(async (key) => `https://signed.example/${key}`),
      delete: jest.fn(async (_key: string): Promise<void> => {}),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: STORAGE_PROVIDER, useValue: storageMock },
      ],
    }).compile();
    service = module.get<MediaService>(MediaService);
  });

  it('[HP] uploads to an allowlisted public branding folder', async () => {
    const url = await service.uploadBase64(
      PNG_BASE64,
      'image/png',
      'branding/logos',
    );
    expect(url).toMatch(/^https:\/\/public\.example\/branding\/logos\//);
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
    expect(storageMock.uploadPrivate).not.toHaveBeenCalled();
  });

  it('[SEC] rejects folders outside the public allowlist (incl. kyc/evidence destinations)', async () => {
    for (const folder of [
      'kyc',
      'kyc/washer/x',
      'evidence',
      'private-evidence/a',
    ]) {
      await expect(
        service.uploadBase64(PNG_BASE64, 'image/png', folder),
      ).rejects.toThrow(BadRequestException);
    }
    expect(storageMock.upload).not.toHaveBeenCalled();
  });

  it('[SEC] still rejects traversal and absolute folder paths', async () => {
    for (const folder of ['../kyc', '/branding', 'branding/../kyc']) {
      await expect(
        service.uploadBase64(PNG_BASE64, 'image/png', folder),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('[NP] keeps DOCX off the public media path (GAP-M-020: DOCX is evidence-only)', async () => {
    await expect(
      service.uploadBase64(
        PNG_BASE64,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'branding',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
