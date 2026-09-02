/**
 * CANONICAL MARKETPLACE RULE (GAP-P0-027), end to end through the real
 * resolver + guard stack.
 *
 *   Discoverability and bookability are gated by PAYMENT READINESS ONLY —
 *   wallet.activatedAt != null AND balance >= DISCOVERY_ACCEPT_MIN_CENTAVOS
 *   (₱100). KYC verificationStatus NEVER gates either; it only drives the
 *   Verified/Unverified badge (ProviderCard.isVerified).
 *
 * A unit test on DiscoveryService can be made to agree with a wrong rule as
 * easily as a right one, because it stubs the models. These cases seed real
 * documents, call discoverProviders / quoteOnlineOrder over HTTP as a real
 * customer, and assert on what the customer actually receives.
 *
 * KYC state transitions are driven through the real approveKycDocument /
 * rejectKycDocument mutations (admin role), not by writing verificationStatus
 * by hand — so the badge under test is the one the product produces.
 */
import { Types } from 'mongoose';
import { createE2EApp, E2EContext } from './utils/e2e-app';
import {
  gql,
  gqlOk,
  firstErrorMessage,
  seedUser,
  seedMerchantBranch,
  seedWasher,
  seedWallet,
  seedService,
  seedKycDocuments,
  MAP,
} from './utils/seed';

const DISCOVER = /* GraphQL */ `
  query Discover($filter: DiscoverProvidersInput!) {
    discoverProviders(filter: $filter) {
      branchId
      name
      providerType
      isVerified
      verificationBadges
    }
  }
`;

const QUOTE = /* GraphQL */ `
  query Quote($input: QuoteOrderInput!) {
    quoteOnlineOrder(input: $input) {
      serviceSubtotalCentavos
      platformFeeCentavos
      customerTotalCentavos
    }
  }
`;

const APPROVE = /* GraphQL */ `
  mutation Approve($documentId: ID!) {
    approveKycDocument(documentId: $documentId) {
      _id
      status
    }
  }
`;

const REJECT = /* GraphQL */ `
  mutation Reject(
    $documentId: ID!
    $reason: KycRejectionReason!
    $note: String
  ) {
    rejectKycDocument(documentId: $documentId, reason: $reason, note: $note) {
      _id
      status
    }
  }
`;

// ₱100 floor — src/wallets/wallet.constants.ts DISCOVERY_ACCEPT_MIN_CENTAVOS.
const ACCEPT_MIN = 10_000;

describe('Marketplace eligibility vs KYC verification (e2e)', () => {
  let ctx: E2EContext;
  let server: any;
  let customerUid: string;
  let adminUid: string;

  const discover = async (search: string) => {
    const data = await gqlOk(
      server,
      DISCOVER,
      {
        filter: {
          latitude: MAP.latitude,
          longitude: MAP.longitude,
          radiusKm: 50,
          search,
          limit: 100,
        },
      },
      customerUid,
    );
    return data.discoverProviders as {
      branchId: string;
      isVerified: boolean;
      verificationBadges: string[];
    }[];
  };

  const findCard = async (search: string, branchId: string) =>
    (await discover(search)).find((c) => c.branchId === branchId);

  /** Quote a trivial order — the booking-authorization probe. */
  const quote = (branchId: string, serviceRefId: string) =>
    gql(
      server,
      QUOTE,
      {
        input: {
          branchId,
          providerType: 'MERCHANT',
          serviceLines: [{ serviceRefId, estimatedWeightKg: 5 }],
        },
      },
      customerUid,
    );

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer();
    customerUid = await seedUser(ctx.connection, 'customer');
    adminUid = await seedUser(ctx.connection, 'admin');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // -------------------------------------------------------------------------
  // (a) No wallet activation => NOT discoverable, NOT bookable
  // -------------------------------------------------------------------------
  describe('(a) provider with no wallet activation', () => {
    let branchId: string;
    let serviceId: string;
    let name: string;

    beforeAll(async () => {
      name = `CaseA-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, { branchName: name });
      branchId = b.branchId;
      serviceId = await seedService(ctx.connection, branchId, b.ownerUid);
      // Wallet exists with plenty of money but was NEVER activated.
      await seedWallet(ctx.connection, branchId, 500_000, false);
    });

    it('is NOT returned by discoverProviders', async () => {
      expect(await findCard(name, branchId)).toBeUndefined();
    });

    it('cannot be quoted — booking is refused on payment-readiness grounds', async () => {
      const res = await quote(branchId, serviceId);
      expect(firstErrorMessage(res)).toBe(
        'This provider is not currently able to take marketplace orders',
      );
    });
  });

  describe('(a2) provider whose wallet is activated but has fallen below the ₱100 floor', () => {
    let branchId: string;
    let name: string;

    beforeAll(async () => {
      name = `CaseA2-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, { branchName: name });
      branchId = b.branchId;
      await seedWallet(ctx.connection, branchId, ACCEPT_MIN - 1, true);
    });

    it('is NOT discoverable one centavo below the floor', async () => {
      expect(await findCard(name, branchId)).toBeUndefined();
    });
  });

  describe('(a3) provider exactly at the ₱100 floor', () => {
    let branchId: string;
    let name: string;

    beforeAll(async () => {
      name = `CaseA3-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, { branchName: name });
      branchId = b.branchId;
      await seedWallet(ctx.connection, branchId, ACCEPT_MIN, true);
    });

    it('IS discoverable exactly at the floor (>=, not >)', async () => {
      expect(await findCard(name, branchId)).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // (b) Funded + KYC never started => discoverable, unverified
  // -------------------------------------------------------------------------
  describe('(b) funded provider with no KYC submitted at all', () => {
    let branchId: string;
    let serviceId: string;
    let name: string;

    beforeAll(async () => {
      name = `CaseB-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, {
        branchName: name,
        verificationStatus: 'PENDING',
        verifiedAt: null,
      });
      branchId = b.branchId;
      serviceId = await seedService(ctx.connection, branchId, b.ownerUid);
      await seedWallet(ctx.connection, branchId, 500_000, true);
    });

    it('IS discoverable', async () => {
      expect(await findCard(name, branchId)).toBeDefined();
    });

    it('carries isVerified = false (Unverified ribbon)', async () => {
      expect((await findCard(name, branchId))!.isVerified).toBe(false);
    });

    it('CAN be quoted — verification is not a booking gate', async () => {
      const res = await quote(branchId, serviceId);
      expect(res.errors).toBeUndefined();
      expect(res.data.quoteOnlineOrder.serviceSubtotalCentavos).toBe(30000);
    });
  });

  // -------------------------------------------------------------------------
  // (c) Funded + KYC submitted, awaiting review => discoverable, unverified
  // -------------------------------------------------------------------------
  describe('(c) funded provider with KYC PENDING review', () => {
    let branchId: string;
    let serviceId: string;
    let name: string;

    beforeAll(async () => {
      name = `CaseC-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, {
        branchName: name,
        verificationStatus: 'PENDING',
      });
      branchId = b.branchId;
      serviceId = await seedService(ctx.connection, branchId, b.ownerUid);
      await seedWallet(ctx.connection, branchId, 500_000, true);
      await seedKycDocuments(
        ctx.connection,
        branchId,
        'MERCHANT_BRANCH',
        b.ownerUid,
      );
    });

    it('IS discoverable while documents sit in the review queue', async () => {
      expect(await findCard(name, branchId)).toBeDefined();
    });

    it('is still isVerified = false until every required document is approved', async () => {
      expect((await findCard(name, branchId))!.isVerified).toBe(false);
    });

    it('CAN be quoted while under review', async () => {
      const res = await quote(branchId, serviceId);
      expect(res.errors).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (d) Funded + KYC approved => discoverable, VERIFIED
  // -------------------------------------------------------------------------
  describe('(d) funded provider whose KYC is fully approved', () => {
    let branchId: string;
    let serviceId: string;
    let name: string;
    let docIds: string[];

    beforeAll(async () => {
      name = `CaseD-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, {
        branchName: name,
        verificationStatus: 'PENDING',
      });
      branchId = b.branchId;
      serviceId = await seedService(ctx.connection, branchId, b.ownerUid);
      await seedWallet(ctx.connection, branchId, 500_000, true);
      docIds = await seedKycDocuments(
        ctx.connection,
        branchId,
        'MERCHANT_BRANCH',
        b.ownerUid,
      );
    });

    it('flips isVerified false -> true only after the LAST required document is approved', async () => {
      // One of two approved: still unverified.
      await gqlOk(server, APPROVE, { documentId: docIds[0] }, adminUid);
      expect((await findCard(name, branchId))!.isVerified).toBe(false);

      // Second (final) approval flips the badge.
      await gqlOk(server, APPROVE, { documentId: docIds[1] }, adminUid);
      expect((await findCard(name, branchId))!.isVerified).toBe(true);
    });

    it('stamps verificationStatus = APPROVED and verifiedAt on the branch', async () => {
      const branch = await ctx.connection
        .collection('branches')
        .findOne({ _id: new Types.ObjectId(branchId) });
      expect(branch!.verificationStatus).toBe('APPROVED');
      expect(branch!.verifiedAt).toBeTruthy();
    });

    it('exposes the VERIFIED_BUSINESS badge on the card', async () => {
      expect((await findCard(name, branchId))!.verificationBadges).toContain(
        'VERIFIED_BUSINESS',
      );
    });

    it('remains quotable (approval changes the badge, not the gate)', async () => {
      const res = await quote(branchId, serviceId);
      expect(res.errors).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (e) Funded + KYC REJECTED => STILL discoverable, unverified
  // This is the case a verification-gated implementation gets wrong.
  // -------------------------------------------------------------------------
  describe('(e) funded provider whose KYC was rejected', () => {
    let branchId: string;
    let serviceId: string;
    let name: string;
    let docIds: string[];

    beforeAll(async () => {
      name = `CaseE-${Date.now()}`;
      const b = await seedMerchantBranch(ctx.connection, {
        branchName: name,
        verificationStatus: 'PENDING',
      });
      branchId = b.branchId;
      serviceId = await seedService(ctx.connection, branchId, b.ownerUid);
      await seedWallet(ctx.connection, branchId, 500_000, true);
      docIds = await seedKycDocuments(
        ctx.connection,
        branchId,
        'MERCHANT_BRANCH',
        b.ownerUid,
      );
      await gqlOk(
        server,
        REJECT,
        { documentId: docIds[0], reason: 'EXPIRED' },
        adminUid,
      );
    });

    it('records verificationStatus = REJECTED on the provider', async () => {
      const branch = await ctx.connection
        .collection('branches')
        .findOne({ _id: new Types.ObjectId(branchId) });
      expect(branch!.verificationStatus).toBe('REJECTED');
    });

    it('is STILL discoverable after rejection — funding, not KYC, is the gate', async () => {
      expect(await findCard(name, branchId)).toBeDefined();
    });

    it('is unverified after rejection', async () => {
      expect((await findCard(name, branchId))!.isVerified).toBe(false);
    });

    it('can STILL be quoted after rejection', async () => {
      const res = await quote(branchId, serviceId);
      expect(res.errors).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The same rule for home washers (separate collection, separate code path)
  // -------------------------------------------------------------------------
  describe('home washers follow the identical rule', () => {
    it('unfunded washer is not discoverable; funded washer is, unverified', async () => {
      const nameA = `WasherUnfunded-${Date.now()}`;
      const a = await seedWasher(ctx.connection, { displayName: nameA });
      await seedWallet(ctx.connection, a.branchId, 500_000, false);

      const nameB = `WasherFunded-${Date.now()}`;
      const b = await seedWasher(ctx.connection, { displayName: nameB });
      await seedWallet(ctx.connection, b.branchId, 500_000, true);

      expect(await findCard(nameA, a.branchId)).toBeUndefined();
      const cardB = await findCard(nameB, b.branchId);
      expect(cardB).toBeDefined();
      expect(cardB!.isVerified).toBe(false);
    });

    it("a washer's technical anchor branch is never listed as a second, merchant card", async () => {
      // Both a washer's anchor Branch and her WasherProfile live in `branches`
      // /`washer_profiles` under the SAME branchId and share ONE wallet, so a
      // funded washer satisfies the merchant leg of discovery too. The only
      // thing keeping her from appearing twice — the second card being a
      // MERCHANT card that exposes her exact address — is the anchor branch's
      // isOnline:false. Assert exactly one card per branchId. (KNOWN_RISKS.md)
      const name = `WasherSingle-${Date.now()}`;
      const w = await seedWasher(ctx.connection, { displayName: name });
      await seedWallet(ctx.connection, w.branchId, 500_000, true);

      const cards = (await discover(name)).filter(
        (c) => c.branchId === w.branchId,
      );
      expect(cards).toHaveLength(1);
      expect((cards[0] as any).providerType).toBe('WASHER');
    });

    it('a funded washer with all KYC approved shows isVerified = true', async () => {
      const name = `WasherVerified-${Date.now()}`;
      const w = await seedWasher(ctx.connection, { displayName: name });
      await seedWallet(ctx.connection, w.branchId, 500_000, true);
      const docs = await seedKycDocuments(
        ctx.connection,
        w.washerId,
        'WASHER',
        w.ownerUid,
      );
      for (const id of docs) {
        await gqlOk(server, APPROVE, { documentId: id }, adminUid);
      }
      const card = await findCard(name, w.branchId);
      expect(card).toBeDefined();
      expect(card!.isVerified).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization on the discovery surface itself (guards run for real here)
  // -------------------------------------------------------------------------
  describe('discovery authorization', () => {
    it('rejects an unauthenticated discoverProviders call', async () => {
      const res = await gql(server, DISCOVER, {
        filter: { latitude: MAP.latitude, longitude: MAP.longitude },
      });
      expect(firstErrorMessage(res)).toMatch(/Authentication required/i);
    });

    it('rejects a merchant calling the customer-only discoverProviders', async () => {
      const merchantUid = await seedUser(ctx.connection, 'merchant');
      const res = await gql(
        server,
        DISCOVER,
        { filter: { latitude: MAP.latitude, longitude: MAP.longitude } },
        merchantUid,
      );
      expect(firstErrorMessage(res)).toMatch(/do not have permission/i);
    });

    it('rejects a non-admin trying to approve a KYC document', async () => {
      const b = await seedMerchantBranch(ctx.connection);
      const docs = await seedKycDocuments(
        ctx.connection,
        b.branchId,
        'MERCHANT_BRANCH',
        b.ownerUid,
      );
      const res = await gql(
        server,
        APPROVE,
        { documentId: docs[0] },
        b.ownerUid,
      );
      expect(firstErrorMessage(res)).toMatch(/do not have permission/i);
    });
  });
});
