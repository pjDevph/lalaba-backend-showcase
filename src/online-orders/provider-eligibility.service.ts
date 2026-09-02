import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import {
  WasherProfile,
  WasherProfileDocument,
  WasherStatus,
} from '../washer/schemas/washer-profile.schema';
import { washerStoreName } from '../washer/washer-name.util';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { DISCOVERY_ACCEPT_MIN_CENTAVOS } from '../wallets/wallet.constants';
import { ProviderType } from './schemas/order-status.enum';
import { BookingAvailabilityService } from '../booking-availability/booking-availability.service';

export type BookingStage = 'quote' | 'create' | 'accept';

export interface ProviderBookableContext {
  stage: BookingStage;
  /** Customer address coordinates — used for the washer service-radius check
   * when present (createOrder passes them; quoteOrder has no address). */
  customerLat?: number;
  customerLng?: number;
}

export interface BookableProvider {
  branch: BranchDocument;
  washer?: WasherProfileDocument;
  /** Provider display name + owner uid, resolved per provider type. */
  providerName: string;
  providerUid: string;
}

/**
 * Central booking-eligibility gate (GAP-P0-006), shared by quoteOrder,
 * createOrder and acceptOrder so a provider that isn't actually bookable can
 * never be booked through any of the three doors.
 *
 * CANONICAL MARKETPLACE RULE (settled, GAP-P0-027): bookability is gated by
 * payment-readiness — wallet activated (activatedAt != null) AND balance at or
 * above the shared ₱100 floor — NEVER by KYC verificationStatus. Verification
 * only drives the Verified/Unverified badge that discovery exposes separately.
 */
@Injectable()
export class ProviderEligibilityService {
  constructor(
    @InjectModel(Branch.name)
    private readonly branchModel: Model<BranchDocument>,
    @InjectModel(WasherProfile.name)
    private readonly washerModel: Model<WasherProfileDocument>,
    @InjectModel(Wallet.name)
    private readonly walletModel: Model<WalletDocument>,
    private readonly bookingAvailability: BookingAvailabilityService,
  ) {}

  /**
   * Throws BadRequestException with a customer-readable reason when the
   * provider is not bookable; returns the resolved provider docs otherwise
   * (so callers don't re-fetch what was just validated).
   */
  async assertProviderBookable(
    providerType: ProviderType,
    branchId: string,
    context: ProviderBookableContext,
  ): Promise<BookableProvider> {
    const branch = await this.branchModel.findById(branchId).exec();
    if (!branch) throw new BadRequestException('Provider branch not found');

    let washer: WasherProfileDocument | undefined;
    let providerName = branch.branchName;
    let providerUid = branch.uid;

    if (providerType === ProviderType.WASHER) {
      washer =
        (await this.washerModel.findOne({ branchId }).exec()) ?? undefined;
      if (!washer) throw new BadRequestException('Washer not found');
      // Snapshotted onto the order as the provider's name, so it has to be the
      // same shop name discovery showed — not her personal name.
      providerName = washerStoreName(washer);
      providerUid = washer.uid;

      if (washer.status !== WasherStatus.ACTIVE) {
        throw new BadRequestException(
          'This washer is not currently active on the platform',
        );
      }
      // Availability is the washer's own "accepting bookings" switch — it
      // gates NEW bookings (quote/create). An already-placed order may still
      // be accepted after she flips it off mid-day.
      if (context.stage !== 'accept' && !washer.isAvailable) {
        throw new BadRequestException(
          'This washer is not accepting bookings right now',
        );
      }
      // GAP: createOrder already rejects a paused washer via
      // BookingAvailabilityService.assertDayBookable — but quoteOrder skipped
      // straight past that, so a customer could complete the whole quote step
      // against a washer who had paused, only to hit a rejection at create.
      // Checked here so quote and create agree from the first screen.
      if (context.stage !== 'accept') {
        const config = await this.bookingAvailability.findConfig(branchId);
        if (config?.bookingsPaused) {
          throw new BadRequestException(
            'This washer has paused new bookings right now',
          );
        }
      }
      this.assertServiceAreaConfigured(washer, context);
      this.assertWithinServiceRadius(washer, context);
    } else {
      // Merchant branch: must exist as an operating, online storefront.
      if (!branch.isActive) {
        throw new BadRequestException('This branch is not active');
      }
      if (!branch.isOnline) {
        throw new BadRequestException(
          'This branch is currently closed for online orders',
        );
      }
    }

    // Marketplace eligibility = payment-readiness (canonical rule). KYC
    // verificationStatus is deliberately NOT consulted here.
    const wallet = await this.walletModel.findOne({ branchId }).exec();
    if (
      !wallet ||
      wallet.activatedAt == null ||
      wallet.balanceCentavos < DISCOVERY_ACCEPT_MIN_CENTAVOS
    ) {
      throw new BadRequestException(
        'This provider is not currently able to take marketplace orders',
      );
    }

    return { branch, washer, providerName, providerUid };
  }

  /** Haversine distance in km — same math discovery uses for radius filters. */
  distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * A washer without a pin and a radius has no service area at all.
   *
   * This is separate from assertWithinServiceRadius, which compares two known
   * points and therefore has to no-op when either is missing. That no-op FAILED
   * OPEN: an unconfigured washer passed the radius check on a technicality and
   * was fully bookable, then had orders routed to her from anywhere in the
   * country. Distance is the only thing matching a customer to a home washer,
   * so "no service area" has to be a refusal, not a skipped comparison.
   *
   * Skipped at 'accept': the order's provider was already validated at create
   * time, and re-checking here would strand a live order — punishing the
   * customer for a configuration change made after they booked.
   */
  private assertServiceAreaConfigured(
    washer: WasherProfileDocument,
    context: ProviderBookableContext,
  ): void {
    if (context.stage === 'accept') return;
    if (
      washer.serviceRadiusKm == null ||
      washer.mapLocation?.latitude == null ||
      washer.mapLocation?.longitude == null
    ) {
      throw new BadRequestException(
        'This washer has not set up her service area yet',
      );
    }
  }

  private assertWithinServiceRadius(
    washer: WasherProfileDocument,
    context: ProviderBookableContext,
  ): void {
    // Only enforceable when both sides have coordinates and the washer has a
    // configured radius — checked at create time (the customer's address is
    // known there); quote has no address, accept re-checks nothing spatial
    // because the order snapshot was already validated at create.
    if (
      context.customerLat == null ||
      context.customerLng == null ||
      washer.serviceRadiusKm == null ||
      washer.mapLocation?.latitude == null ||
      washer.mapLocation?.longitude == null
    ) {
      return;
    }
    const km = this.distanceKm(
      context.customerLat,
      context.customerLng,
      washer.mapLocation.latitude,
      washer.mapLocation.longitude,
    );
    if (km > washer.serviceRadiusKm) {
      throw new BadRequestException(
        'This address is outside the washer’s service area',
      );
    }
  }
}
