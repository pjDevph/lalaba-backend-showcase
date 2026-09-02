/**
 * Direct-to-Mongo seeding for the e2e suites.
 *
 * Seeding is done against the live app's mongoose connection (real schemas,
 * real validation, real indexes) rather than through GraphQL, because the
 * onboarding mutations are not what these suites are testing — the read/booking
 * paths are. Everything that IS under test is exercised through the resolvers.
 */
import { Connection, Types } from 'mongoose';
import request from 'supertest';

// Fixed role ObjectIds seeded on bootstrap by RolesService (src/roles/roles.service.ts).
export const ROLE_IDS = {
  admin: '6a11bcb8ffd7d2160b1e53b8',
  merchant: '6a11bcb8ffd7d2160b1e53b9',
  washer: '6a11bcb8ffd7d2160b1e53ba',
  support: '6a11bcb8ffd7d2160b1e53bb',
  staff: '6a11bcb8ffd7d2160b1e53bc',
  customer: '6a11bcb8ffd7d2160b1e53bd',
  courier: '6a11bcb8ffd7d2160b1e53be',
} as const;

export type SeedRole = keyof typeof ROLE_IDS;

export const ADDRESS = {
  regionName: 'NCR',
  provinceName: 'Metro Manila',
  cityMunicipalityName: 'Makati',
  barangayName: 'Bel-Air',
  streetAddress: '123 Test St',
};

export const MAP = { latitude: 14.5547, longitude: 121.0244 };

const ALL_DAY = {
  isOpen: true,
  is24Hours: true,
  timeSlots: [{ open: '00:00', close: '23:59' }],
};
export const OPEN_ALWAYS = {
  monday: ALL_DAY,
  tuesday: ALL_DAY,
  wednesday: ALL_DAY,
  thursday: ALL_DAY,
  friday: ALL_DAY,
  saturday: ALL_DAY,
  sunday: ALL_DAY,
};

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function seedUser(
  conn: Connection,
  role: SeedRole,
  overrides: Record<string, any> = {},
): Promise<string> {
  const uid = overrides._id ?? `uid-${role}-${uniq()}`;
  await conn.collection('users').insertOne({
    role: new Types.ObjectId(ROLE_IDS[role]),
    email: `${uid}@e2e.test`,
    firstName: 'Test',
    lastName: role,
    phoneNumber: '09171234567',
    isActive: true,
    accountStatus: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    // _id last: the uid IS the Firebase uid and must never be overridden.
    _id: uid,
  });
  return uid;
}

export interface SeedBranchOptions {
  isActive?: boolean;
  isOnline?: boolean;
  verificationStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  verifiedAt?: Date | null;
  branchName?: string;
}

/** Merchant branch + its owner user. */
export async function seedMerchantBranch(
  conn: Connection,
  opts: SeedBranchOptions = {},
): Promise<{ branchId: string; ownerUid: string }> {
  const ownerUid = await seedUser(conn, 'merchant');
  const _id = new Types.ObjectId();
  await conn.collection('branches').insertOne({
    _id,
    uid: ownerUid,
    branchName: opts.branchName ?? `E2E Laundromat ${uniq()}`,
    branchAddress: { ...ADDRESS },
    branchMapLocation: { ...MAP },
    branchPhoneNumber: '09170000000',
    operatingHours: OPEN_ALWAYS,
    ratingAggregate: {},
    verificationStatus: opts.verificationStatus ?? 'PENDING',
    verifiedAt: opts.verifiedAt ?? null,
    isActive: opts.isActive ?? true,
    isOnline: opts.isOnline ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { branchId: String(_id), ownerUid };
}

export interface SeedWasherOptions extends SeedBranchOptions {
  status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  isAvailable?: boolean;
  displayName?: string;
  offeredServiceTemplateIds?: string[];
}

/**
 * Home washer: anchor branch + washer_profiles doc + owner user.
 *
 * The anchor Branch is seeded exactly as UsersService.createWasherShopAnchor
 * creates it (src/users/users.service.ts:132-176) — in particular
 * `isOnline: false`. That flag is the ONLY thing stopping a washer's technical
 * anchor from also being listed as a MERCHANT card in discovery, since both
 * live in `branches` and share the same wallet. Seeding it `true` produces a
 * duplicate card (and would leak the washer's exact address); see
 * KNOWN_RISKS.md.
 */
export async function seedWasher(
  conn: Connection,
  opts: SeedWasherOptions = {},
): Promise<{ branchId: string; washerId: string; ownerUid: string }> {
  const ownerUid = await seedUser(conn, 'washer');
  const branchOid = new Types.ObjectId();
  await conn.collection('branches').insertOne({
    _id: branchOid,
    uid: ownerUid,
    branchName: opts.displayName ?? `Washer anchor ${uniq()}`,
    branchAddress: { ...ADDRESS },
    branchMapLocation: { ...MAP },
    branchPhoneNumber: '09170000001',
    operatingHours: OPEN_ALWAYS,
    ratingAggregate: {},
    verificationStatus: 'PENDING',
    verifiedAt: null,
    isActive: true,
    // Production shape: the anchor branch is NEVER online (users.service.ts:165).
    isOnline: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const washerOid = new Types.ObjectId();
  await conn.collection('washer_profiles').insertOne({
    _id: washerOid,
    uid: ownerUid,
    displayName: opts.displayName ?? `E2E Washer ${uniq()}`,
    phoneNumber: '09170000001',
    address: { ...ADDRESS },
    mapLocation: { ...MAP },
    serviceRadiusKm: 50,
    offeredServiceTemplateIds: opts.offeredServiceTemplateIds ?? [],
    ratingAggregate: {},
    status: opts.status ?? 'ACTIVE',
    verificationStatus: opts.verificationStatus ?? 'PENDING',
    verifiedAt: opts.verifiedAt ?? null,
    isAvailable: opts.isAvailable ?? true,
    slotsUsedToday: 0,
    maxOrdersPerDay: null,
    branchId: String(branchOid),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    branchId: String(branchOid),
    washerId: String(washerOid),
    ownerUid,
  };
}

/**
 * Wallet for a branch. `activated` stamps activatedAt — the payment-readiness
 * marker discovery and booking eligibility both consult.
 */
export async function seedWallet(
  conn: Connection,
  branchId: string,
  balanceCentavos: number,
  activated: boolean,
): Promise<void> {
  await conn.collection('wallets').insertOne({
    _id: new Types.ObjectId(),
    branchId,
    balanceCentavos,
    activatedAt: activated ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function seedService(
  conn: Connection,
  branchId: string,
  ownerUid: string,
  overrides: Record<string, any> = {},
): Promise<string> {
  const _id = new Types.ObjectId();
  await conn.collection('services').insertOne({
    _id,
    uid: ownerUid,
    branchId,
    serviceName: 'Wash & Fold',
    price: 6000, // ₱60.00 per kilo, in centavos
    pricingType: 'per_kilo',
    baseKilos: null,
    excessRate: null,
    category: 'wash_and_fold',
    isActive: true,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return String(_id);
}

export async function seedAddress(
  conn: Connection,
  uid: string,
  overrides: Record<string, any> = {},
): Promise<string> {
  const _id = new Types.ObjectId();
  await conn.collection('addresses').insertOne({
    _id,
    uid,
    label: 'Home',
    address: { ...ADDRESS },
    mapLocation: { ...MAP },
    isDefault: false,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return String(_id);
}

/**
 * Seeds SUBMITTED KYC documents straight into Mongo. Only the file upload is
 * bypassed (it needs the private object store); the review/approval path is
 * then driven through the real approveKycDocument / rejectKycDocument
 * mutations so the verificationStatus transition under test is the product's.
 */
export async function seedKycDocuments(
  conn: Connection,
  providerId: string,
  providerType: 'MERCHANT_BRANCH' | 'WASHER',
  ownerUid: string,
): Promise<string[]> {
  // Must mirror REQUIRED_KYC_DOCUMENT_TYPES. Seeding a stale, smaller set
  // makes "all documents approved" unreachable, so provider-level assertions
  // fail for a fixture reason rather than a code one. BUSINESS_PERMIT is
  // deliberately absent: it is submittable but no longer required, so
  // rejecting it must NOT revoke a badge.
  const types =
    providerType === 'MERCHANT_BRANCH'
      ? [
          'OWNER_VALID_ID',
          'DTI_CERTIFICATE',
          'BIR_2303',
          'BUSINESS_PHOTO_STOREFRONT',
          'BUSINESS_PHOTO_INTERIOR',
          'BUSINESS_PHOTO_MACHINES',
        ]
      : [
          'VALID_ID',
          'VALID_ID_BACK',
          'SELFIE',
          'PROOF_OF_ADDRESS',
          'BARANGAY_CLEARANCE',
        ];
  const ids: string[] = [];
  for (const documentType of types) {
    const _id = new Types.ObjectId();
    await conn.collection('kyc_documents').insertOne({
      _id,
      providerId,
      providerType,
      ownerUid,
      documentType,
      storageObjectKey: `kyc/${providerType.toLowerCase()}/${providerId}/${documentType.toLowerCase()}/e2e.jpg`,
      mimeType: 'image/jpeg',
      fileSizeBytes: 1024,
      status: 'SUBMITTED',
      submittedAt: new Date(),
      claimedByUid: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ids.push(String(_id));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// GraphQL over HTTP
// ---------------------------------------------------------------------------

export interface GqlResult<T = any> {
  data: T | null;
  errors?: { message: string; extensions?: any }[];
  status: number;
}

/**
 * Posts an operation to /graphql on the real server. The bearer token is the
 * uid itself (see FakeFirebaseService); pass undefined for an anonymous call.
 */
export async function gql<T = any>(
  server: any,
  query: string,
  variables: Record<string, any> = {},
  asUid?: string,
): Promise<GqlResult<T>> {
  const req = request(server).post('/graphql').send({ query, variables });
  if (asUid) req.set('Authorization', `Bearer ${asUid}`);
  const res = await req;
  return {
    data: res.body?.data ?? null,
    errors: res.body?.errors,
    status: res.status,
  };
}

/** Same as gql() but throws on any GraphQL error — for arrange-phase calls. */
export async function gqlOk<T = any>(
  server: any,
  query: string,
  variables: Record<string, any> = {},
  asUid?: string,
): Promise<T> {
  const res = await gql<T>(server, query, variables, asUid);
  if (res.errors?.length) {
    throw new Error(
      `GraphQL error: ${res.errors.map((e) => e.message).join(' | ')}`,
    );
  }
  return res.data as T;
}

export const firstErrorMessage = (res: GqlResult): string =>
  res.errors?.[0]?.message ?? '';
