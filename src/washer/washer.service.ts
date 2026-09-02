import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  WasherProfile,
  WasherProfileDocument,
  WasherStatus,
} from './schemas/washer-profile.schema';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  CAP_COUNTED_STATUSES,
} from '../online-orders/schemas/order-status.enum';
import { Rating, RatingDocument } from '../ratings/schemas/rating.schema';
import { UpdateWasherProfileInput } from './dto/update-washer-profile.input';
import { WasherStats } from './models/washer-stats.model';
import { WasherReport } from './models/washer-report.model';
import { WasherServiceTemplatesService } from '../washer-service-templates/washer-service-templates.service';
import { CertificationProofInput } from './dto/certification-proof.input';
import {
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  STORAGE_PROVIDER,
} from '../storage/storage-provider.interface';
import type { StorageProvider } from '../storage/storage-provider.interface';
import { User } from '../users/schemas/user.schema';
import { Role } from '../users/schemas/role.schema';
import { UsersService } from '../users/users.service';
import { BookingPolicyService } from '../booking-policy/booking-policy.service';

const PH_OFFSET_MS = 8 * 3600 * 1000;

/**
 * `MapLocation.latitude/longitude` are non-nullable in the SDL while
 * `WasherProfile.mapLocation` itself is nullable — so a stored pin is legal
 * only in two shapes: absent, or complete. A document holding the object
 * without usable coordinates is unrepresentable, and GraphQL answers the whole
 * query with "Cannot return null for non-nullable field MapLocation.latitude",
 * taking down every read of that washer's profile — not just the pin.
 *
 * Nothing in this service writes that shape, but pre-Phase-2 and hand-seeded
 * documents carry it (see scripts/migrations/migrate-washer-map-location.ts,
 * which repairs them at rest). Normalising on the way out means one bad
 * document degrades to "no pin set" instead of a hard failure.
 */
function normalizeMapLocation<T extends WasherProfile>(profile: T): T {
  const loc = profile?.mapLocation;
  if (!loc) return profile;
  if (Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) {
    return profile;
  }
  // Mongoose documents ignore plain assignment to a sub-document path unless
  // the path is marked modified; `set` handles both documents and lean objects.
  if (typeof (profile as any).set === 'function') {
    (profile as any).set('mapLocation', null);
  } else {
    profile.mapLocation = undefined;
  }
  return profile;
}

// Same evidence allowlist as the KYC path (GAP-M-020) — these files are never
// served publicly, so DOCX/HEIC are acceptable here.
const CERT_PROOF_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
};

// ~5 MB decoded, matching submitKycDocument.
const MAX_CERT_PROOF_BASE64_LENGTH = 7 * 1024 * 1024;

const CERT_PROOF_REVIEWER_ROLES = ['admin', 'support'];

// Start of the current day in PH time (UTC+8) — same convention as
// OnlineOrdersService.startOfTodayPH so slotsUsedToday matches the daily-cap
// counter exactly.
function startOfTodayPH(): Date {
  const nowInPH = new Date(Date.now() + PH_OFFSET_MS);
  const y = nowInPH.getUTCFullYear();
  const m = nowInPH.getUTCMonth();
  const d = nowInPH.getUTCDate();
  return new Date(Date.UTC(y, m, d) - PH_OFFSET_MS);
}

// Statuses that mean the order is NOT an in-flight job for the washer:
// pre-acceptance lifecycle, provider rejection, and terminal states.
// DISPUTED only ever follows COMPLETED, so it is not "active" work either.
const NON_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.DRAFT,
  OrderStatus.PRICING_VALIDATED,
  OrderStatus.PENDING_PROVIDER_ACCEPTANCE,
  OrderStatus.PROVIDER_CHANGE_PROPOSED,
  OrderStatus.REJECTED_BY_PROVIDER,
  OrderStatus.CANCELLED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUNDED,
  OrderStatus.DISPUTED,
];

@Injectable()
export class WasherService {
  constructor(
    @InjectModel(WasherProfile.name)
    private readonly profileModel: Model<WasherProfileDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly orderModel: Model<OnlineOrderDocument>,
    // Reports average the ratings left in the window. Read-only here; the
    // ratings domain owns every write.
    @InjectModel(Rating.name)
    private readonly ratingModel: Model<RatingDocument>,
    private readonly serviceTemplatesService: WasherServiceTemplatesService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly usersService: UsersService,
    private readonly bookingPolicyService: BookingPolicyService,
  ) {}

  // WasherProfile (with its Branch anchor) is created eagerly at
  // registration (UsersService.register) — every washer account has one, so
  // these no longer auto-create on first access. A missing profile means
  // something upstream is broken, not a normal lazy-init case.
  async getProfile(uid: string): Promise<WasherProfile> {
    const profile = await this.profileModel.findOne({ uid }).exec();
    if (!profile) {
      throw new NotFoundException('Washer profile not found');
    }
    return normalizeMapLocation(profile);
  }

  /**
   * ADMIN-ONLY: set (or clear) a washer's daily order cap.
   *
   * Keyed by `branchId` because that is how Admin already addresses a provider
   * for every other booking-config decision (see
   * BookingAvailabilityService.listProviders — "every row's branchId is
   * directly usable as a config key").
   *
   * `null` CLEARS the cap and means exactly that: no per-washer daily order
   * limit. It does not mean "fall back to a platform number" — the enforcement
   * paths skip the check entirely, and the platform's own booking limits
   * (BookingPolicy entitlement × BookingAvailabilityConfig.dailyBookingLimit)
   * still govern how many slots she can be booked into. There is deliberately
   * no default: a hardcoded 20 here previously outranked both the admin's
   * policy number and what the washer app displayed.
   *
   * 0 is rejected. "Accept nothing" is what her availability toggle and
   * WasherStatus are for, and a second way to say it would let a washer be
   * frozen by a number no screen explains.
   */
  /**
   * One washer by her anchor branchId, or null.
   *
   * Null rather than throwing: the callers are admin-side reads that want to
   * describe a profile (audit trail labels, before/after detail), and failing
   * the whole action because a label could not be resolved would be the wrong
   * trade.
   */
  async findByBranchId(branchId: string): Promise<WasherProfile | null> {
    return this.profileModel.findOne({ branchId }).exec();
  }

  async setDailyOrderCap(
    branchId: string,
    maxOrdersPerDay: number | null,
  ): Promise<WasherProfile> {
    if (maxOrdersPerDay != null && maxOrdersPerDay < 1) {
      throw new BadRequestException(
        'maxOrdersPerDay must be at least 1. To stop bookings entirely, set her status or availability instead.',
      );
    }
    const updated = await this.profileModel
      .findOneAndUpdate(
        { branchId },
        { $set: { maxOrdersPerDay } },
        { new: true },
      )
      .exec();
    if (!updated) throw new NotFoundException('Washer profile not found');
    return normalizeMapLocation(updated);
  }

  async toggleAvailability(uid: string): Promise<WasherProfile> {
    const profile = await this.getProfile(uid);
    const updated = await this.profileModel
      .findOneAndUpdate(
        { uid },
        { $set: { isAvailable: !profile.isAvailable } },
        { new: true },
      )
      .exec();
    return normalizeMapLocation(updated!);
  }

  /**
   * ADMIN-ONLY: suspend or reactivate a washer's account, keyed by branchId
   * like setDailyOrderCap. Unlike the daily cap or isAvailable (both of which
   * the washer influences), this is purely an admin lever — it also
   * denormalizes onto the User doc so GqlAuthGuard can hard-block login for a
   * suspended washer (see users.service.ts#setWasherStatus). Booking and
   * discovery already reject anything other than WasherStatus.ACTIVE
   * (ProviderEligibilityService.assertProviderBookable,
   * DiscoveryService.discoverProviders), so this is the one remaining gap.
   */
  async setStatus(
    branchId: string,
    status: WasherStatus,
  ): Promise<WasherProfile> {
    const profile = await this.profileModel.findOne({ branchId }).exec();
    if (!profile) throw new NotFoundException('Washer profile not found');
    if (profile.status === status) {
      throw new BadRequestException(
        `Washer is already ${status.toLowerCase()}`,
      );
    }
    const updated = await this.profileModel
      .findOneAndUpdate({ branchId }, { $set: { status } }, { new: true })
      .exec();
    await this.usersService.setWasherStatus(
      profile.uid,
      status === WasherStatus.SUSPENDED ? WasherStatus.SUSPENDED : null,
    );
    return normalizeMapLocation(updated!);
  }

  async updateProfile(
    uid: string,
    input: UpdateWasherProfileInput,
  ): Promise<WasherProfile> {
    await this.getProfile(uid); // throws if missing, rather than silently upserting

    // offeredServiceTemplateIds is the one field here that isn't a trusted
    // passthrough — a washer can only offer templates that are real and
    // currently active in Admin's catalog, never an arbitrary/stale ID.
    const patch: Record<string, any> = { ...input };
    if (input.offeredServiceTemplateIds !== undefined) {
      patch.offeredServiceTemplateIds =
        await this.serviceTemplatesService.filterValidActiveIds(
          input.offeredServiceTemplateIds,
        );
    }

    // Rejected, not clamped: a washer who types 50 should see why, not have
    // her input quietly rewritten to whatever the admin ceiling is today.
    if (patch.serviceRadiusKm != null) {
      const policy = await this.bookingPolicyService.current();
      const ceiling = policy.safetyLimits.maxServiceRadiusKm;
      if (patch.serviceRadiusKm > ceiling) {
        throw new BadRequestException(
          `Service radius cannot exceed ${ceiling} km, the platform maximum.`,
        );
      }
    }

    // A pin is all-or-nothing: GraphQL enforces both coordinates on the way in,
    // but an explicit partial would still be storable via $set. Reject rather
    // than persist the shape that breaks every later read of this profile.
    if (patch.mapLocation) {
      const { latitude, longitude } = patch.mapLocation as {
        latitude?: number;
        longitude?: number;
      };
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new BadRequestException(
          'mapLocation requires both latitude and longitude. Omit it to clear the pin.',
        );
      }
      patch.mapLocation = { latitude, longitude };
    }

    // Operating hours are now load-bearing: the booking engine generates a
    // washer's bookable slots from them. A reversed or zero-length window is
    // dropped by normalizeWindows rather than rejected, so without this check a
    // typo like 18:00–08:00 would silently close the day and the only symptom
    // would be "customers can't book me on Tuesdays". The merchant editor
    // validates the same rule client-side; this is the half that can't be
    // bypassed.
    if (patch.operatingHours) {
      const week = patch.operatingHours as Record<
        string,
        { is24Hours?: boolean; timeSlots?: { open: string; close: string }[] }
      >;
      for (const [dayKey, day] of Object.entries(week)) {
        if (!day || day.is24Hours) continue;
        for (const slot of day.timeSlots ?? []) {
          if (slot.close <= slot.open) {
            throw new BadRequestException(
              `${dayKey}: closing time must be after opening time (got ${slot.open}–${slot.close}).`,
            );
          }
        }
      }
    }

    const updated = await this.profileModel
      .findOneAndUpdate({ uid }, { $set: patch }, { new: true })
      .exec();
    return normalizeMapLocation(updated!);
  }

  /**
   * Certification evidence upload — PRIVATE storage only (RISK-P0-002).
   * Replaces the whole evidence set for the washer: every file is stored under
   * a server-derived key in the private evidence bucket and only the object
   * keys are kept. The old public-URL contract is gone (see the resolver's
   * `proofUrls` rejection); reads go through `certificationProofUrls`.
   */
  async submitCertificationProof(
    uid: string,
    proofs: CertificationProofInput[],
  ): Promise<boolean> {
    const profile = await this.getProfile(uid);
    if (!proofs?.length) {
      throw new BadRequestException(
        'At least one certification proof file is required.',
      );
    }

    const objectKeys: string[] = [];
    for (const proof of proofs) {
      const ext = CERT_PROOF_MIME_EXTENSIONS[proof.mimeType];
      if (!ext) {
        throw new BadRequestException(
          'File type not supported. Upload an image (JPG/PNG/HEIC), PDF, or Word document (.docx).',
        );
      }
      const data = proof.base64.includes(',')
        ? proof.base64.split(',')[1]
        : proof.base64;
      if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        throw new BadRequestException(
          'The uploaded file is corrupted or invalid.',
        );
      }
      if (data.length > MAX_CERT_PROOF_BASE64_LENGTH) {
        throw new BadRequestException('File exceeds the 5 MB size limit');
      }
      const buffer = Buffer.from(data, 'base64');
      // Server-derived key — the caller never chooses the folder.
      const key = `cert-proofs/washer/${String(profile._id)}/${randomUUID()}.${ext}`;
      objectKeys.push(
        await this.storageProvider.uploadPrivate(buffer, key, proof.mimeType),
      );
    }

    await this.profileModel
      .findOneAndUpdate(
        { uid },
        { $set: { certProofObjectKeys: objectKeys, certProofUrls: [] } },
      )
      .exec();
    return true;
  }

  /**
   * Short-lived signed read URLs for a washer's certification evidence.
   * Authorization mirrors `kycDocumentUrl`: the owning washer, or an
   * admin/support reviewer. Any other caller is refused.
   *
   * Backward compatible during the transition: profiles whose evidence has not
   * been migrated yet still have public `certProofUrls`, and those are returned
   * verbatim alongside (after) the signed private URLs.
   */
  async certificationProofUrls(
    requester: User,
    washerUid?: string | null,
  ): Promise<string[]> {
    const roleId = (requester.role as unknown as Role)?.roleId;
    const isReviewer = CERT_PROOF_REVIEWER_ROLES.includes(roleId);
    const targetUid = washerUid ?? requester._id;
    if (!isReviewer && targetUid !== requester._id) {
      throw new ForbiddenException(
        'You are not allowed to access this certification evidence.',
      );
    }

    const profile = await this.getProfile(targetUid);
    const signed = await Promise.all(
      (profile.certProofObjectKeys ?? []).map((key) =>
        this.storageProvider.getSignedReadUrl(
          key,
          DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
        ),
      ),
    );
    return [...signed, ...(profile.certProofUrls ?? [])];
  }

  // Canonical stats — read-only aggregation over online_orders (the single
  // source of truth for washer work) plus the profile's cached
  // ratingAggregate. The legacy washer_bookings / washer_earnings collections
  // are no longer read or written anywhere in Phase 2 (GAP-P0-011).
  /**
   * A washer's own performance over a date range — what the Reports screen
   * renders. See WasherReport for why the money here is informational.
   *
   * Windowed on `completedAt` rather than `createdAt`: the question is "what
   * did I finish in this period", and an order booked in March and delivered in
   * April belongs to April's numbers. Cancellations have no completedAt, so
   * they are counted separately off `updatedAt`.
   *
   * Totals are summed from each order's PRICING SNAPSHOT, never recomputed from
   * today's fee rules — a rate change must not retroactively rewrite what a
   * finished order cost.
   */
  async getReport(
    uid: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<WasherReport> {
    const profile = await this.getProfile(uid);

    // PH-local day boundaries: dateTo is INCLUSIVE, so the upper bound is the
    // start of the following day. Using the same day at 00:00 for both would
    // make a single-day report always return zero.
    const from = new Date(`${dateFrom}T00:00:00+08:00`);
    const to = new Date(`${dateTo}T00:00:00+08:00`);
    to.setDate(to.getDate() + 1);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Dates must be in YYYY-MM-DD format.');
    }
    if (to <= from) {
      throw new BadRequestException(
        'The end date must not precede the start date.',
      );
    }

    const [completedAgg, cancelledCount, ratingAgg] = await Promise.all([
      this.orderModel
        .aggregate([
          {
            $match: {
              'provider.providerUid': uid,
              status: OrderStatus.COMPLETED,
              completedAt: { $gte: from, $lt: to },
            },
          },
          {
            $group: {
              _id: null,
              ordersCompleted: { $sum: 1 },
              // customerTotalCentavos is the final, post-weigh-in figure;
              // estimatedTotalCentavos is the quote. Falling back keeps orders
              // that completed without a re-weigh from counting as ₱0.
              grossCentavos: {
                $sum: {
                  $ifNull: [
                    '$pricing.customerTotalCentavos',
                    { $ifNull: ['$pricing.estimatedTotalCentavos', 0] },
                  ],
                },
              },
              platformFeeCentavos: {
                $sum: { $ifNull: ['$pricing.platformFeeCentavos', 0] },
              },
              totalKg: {
                $sum: {
                  $ifNull: [
                    '$pricing.actualWeightKg',
                    { $ifNull: ['$pricing.estimatedWeightKg', 0] },
                  ],
                },
              },
            },
          },
        ])
        .exec(),
      this.orderModel
        .countDocuments({
          'provider.providerUid': uid,
          status: {
            $in: [OrderStatus.CANCELLED, OrderStatus.REJECTED_BY_PROVIDER],
          },
          updatedAt: { $gte: from, $lt: to },
        })
        .exec(),
      this.ratingModel
        .aggregate([
          {
            $match: {
              branchId: profile.branchId,
              createdAt: { $gte: from, $lt: to },
            },
          },
          {
            $group: {
              _id: null,
              reviewCount: { $sum: 1 },
              avgRating: { $avg: '$overallScore' },
            },
          },
        ])
        .exec(),
    ]);

    const totals = completedAgg[0] ?? {};
    const ratings = ratingAgg[0] ?? {};
    const gross = Math.round(totals.grossCentavos ?? 0);
    const fees = Math.round(totals.platformFeeCentavos ?? 0);

    return {
      dateFrom,
      dateTo,
      ordersCompleted: totals.ordersCompleted ?? 0,
      ordersCancelled: cancelledCount,
      grossCentavos: gross,
      platformFeeCentavos: fees,
      netCentavos: gross - fees,
      totalKg: totals.totalKg ?? 0,
      // Null, not 0 — "no ratings yet" and "rated zero" are different answers.
      avgRating: ratings.reviewCount ? ratings.avgRating : null,
      reviewCount: ratings.reviewCount ?? 0,
    };
  }

  async getStats(uid: string): Promise<WasherStats> {
    const startOfToday = startOfTodayPH();

    // Lifetime business overview from the real online-orders this washer has
    // completed (provider.providerUid === washer uid). completedOrders = count,
    // totalKg = laundry weight processed (actual, falling back to estimate),
    // totalLoads = laundry loads handled (one per service line).
    const overviewAgg = this.orderModel
      .aggregate([
        {
          $match: {
            'provider.providerUid': uid,
            status: OrderStatus.COMPLETED,
          },
        },
        {
          $group: {
            _id: null,
            completedOrders: { $sum: 1 },
            totalKg: {
              $sum: {
                $ifNull: [
                  '$pricing.actualWeightKg',
                  { $ifNull: ['$pricing.estimatedWeightKg', 0] },
                ],
              },
            },
            totalLoads: { $sum: { $size: { $ifNull: ['$serviceLines', []] } } },
          },
        },
      ])
      .exec();

    const [
      profile,
      slotsUsedToday,
      activeOrders,
      completedOrdersToday,
      overview,
    ] = await Promise.all([
      this.getProfile(uid),
      // CAP_COUNTED_STATUSES — same filter as the acceptance-time atomic
      // guard (OnlineOrdersService.reserveDailyCapSlot), so this only counts
      // orders she's actually ACCEPTED today (or progressed beyond), not
      // ones still merely awaiting her decision. A pending request doesn't
      // consume a booking slot until she accepts it.
      this.orderModel
        .countDocuments({
          'provider.providerUid': uid,
          createdAt: { $gte: startOfToday },
          status: { $in: CAP_COUNTED_STATUSES },
        })
        .exec(),
      this.orderModel
        .countDocuments({
          'provider.providerUid': uid,
          status: { $nin: NON_ACTIVE_STATUSES },
        })
        .exec(),
      this.orderModel
        .countDocuments({
          'provider.providerUid': uid,
          status: OrderStatus.COMPLETED,
          completedAt: { $gte: startOfToday },
        })
        .exec(),
      overviewAgg,
    ]);

    const overviewRow = overview[0] ?? {};
    const completedOrders = overviewRow.completedOrders ?? 0;
    const totalKg = Math.round((overviewRow.totalKg ?? 0) * 10) / 10;
    const totalLoads = overviewRow.totalLoads ?? 0;

    const ratingCount = profile.ratingAggregate?.count ?? 0;

    return {
      slotsUsedToday,
      activeOrders,
      completedOrders,
      completedOrdersToday,
      totalKg,
      totalLoads,
      avgRating:
        ratingCount > 0 ? profile.ratingAggregate.overallAverage : undefined,
      totalReviews: ratingCount,
    };
  }
}
