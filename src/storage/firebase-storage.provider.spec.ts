import { FirebaseStorageProvider } from './firebase-storage.provider';
import type { FirebaseService } from '../firebase/firebase.service';

// The emulator branch is the whole point of these tests: it is the only place
// where a wrong URL fails silently — the upload succeeds, the DB row looks
// right, and the image simply never renders.
describe('FirebaseStorageProvider', () => {
  const BUCKET = 'lalaba-test.firebasestorage.app';

  const buildFile = () => ({
    save: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getSignedUrl: jest.fn(async () => ['https://signed.example/real?sig=abc']),
  });

  const build = (emulatorHost: string | null) => {
    const file = buildFile();
    const bucket = { name: BUCKET, file: jest.fn(() => file) };
    const firebase = {
      getStorageBucket: () => bucket,
      getStorageEmulatorHost: () => emulatorHost,
    } as unknown as FirebaseService;
    return {
      provider: new FirebaseStorageProvider(firebase),
      bucket,
      file,
    };
  };

  describe('online (real bucket)', () => {
    it('returns a googleapis public URL from upload', async () => {
      const { provider } = build(null);
      const url = await provider.upload(
        Buffer.from('x'),
        'profiles/washers/w1/a.jpg',
        'image/jpeg',
      );
      expect(url).toBe(
        `https://storage.googleapis.com/${BUCKET}/profiles/washers/w1/a.jpg`,
      );
    });

    it('signs private reads', async () => {
      const { provider, file } = build(null);
      const url = await provider.getSignedReadUrl('private-evidence/k.pdf');
      expect(file.getSignedUrl).toHaveBeenCalled();
      expect(url).toBe('https://signed.example/real?sig=abc');
    });
  });

  describe('emulator (local)', () => {
    const HOST = 'localhost:9199';

    it('points upload URLs at the emulator, not googleapis', async () => {
      const { provider } = build(HOST);
      const url = await provider.upload(
        Buffer.from('x'),
        'profiles/washers/w1/a.jpg',
        'image/jpeg',
      );
      expect(url).toBe(
        `http://${HOST}/v0/b/${BUCKET}/o/profiles%2Fwashers%2Fw1%2Fa.jpg?alt=media`,
      );
      expect(url).not.toContain('storage.googleapis.com');
    });

    it('percent-encodes slashes in the key', async () => {
      // The emulator's download endpoint takes the object name as a single
      // path segment. An unencoded slash reads as a URL path separator and 404s.
      const { provider } = build(HOST);
      const url = await provider.upload(
        Buffer.from('x'),
        'a/b/c.jpg',
        'image/jpeg',
      );
      expect(url).toContain('/o/a%2Fb%2Fc.jpg');
    });

    it('does NOT call getSignedUrl for private reads', async () => {
      // The emulator cannot verify V4 signatures; signing would hand back a
      // googleapis URL that points past the emulator entirely.
      const { provider, file } = build(HOST);
      const url = await provider.getSignedReadUrl('private-evidence/k.pdf');
      expect(file.getSignedUrl).not.toHaveBeenCalled();
      expect(url).toBe(
        `http://${HOST}/v0/b/${BUCKET}/o/private-evidence%2Fk.pdf?alt=media`,
      );
    });
  });

  it('keeps private uploads out of the public ACL', async () => {
    const { provider, file } = build(null);
    const key = await provider.uploadPrivate(
      Buffer.from('x'),
      'kyc/washer/w1/selfie/a.jpg',
      'image/jpeg',
    );
    expect(key).toBe('private-evidence/kyc/washer/w1/selfie/a.jpg');
    expect(file.save).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.not.objectContaining({ public: true }),
    );
  });
});
