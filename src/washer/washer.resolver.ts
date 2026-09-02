import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';
import { CertificationProofInput } from './dto/certification-proof.input';
import { WasherService } from './washer.service';
import { WasherProfile } from './schemas/washer-profile.schema';
import { UpdateWasherProfileInput } from './dto/update-washer-profile.input';
import { WasherStats } from './models/washer-stats.model';
import { WasherReport } from './models/washer-report.model';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

// Previously guarded by authentication only (no role check) — any logged-in
// user could trigger these. Fixed per the known legacy gap: only the
// `washer` role may call any method here.
//
// GAP-P0-011: the legacy production paths (todayBookings, bookingHistory,
// updateBookingStatus, washerEarnings, requestWithdrawal) backed by the
// washer_bookings / washer_earnings collections are retired — removed from
// the schema entirely. Order work flows through online_orders and money
// through the consumable wallet (no withdrawals, DECISION_REQUIRED-003).
@Resolver(() => WasherProfile)
@Roles('washer')
@UseGuards(GqlAuthGuard, RolesGuard)
export class WasherResolver {
  constructor(private readonly washerService: WasherService) {}

  @Query(() => WasherProfile, { name: 'washerProfile' })
  async getWasherProfile(@CurrentUser() user: User): Promise<WasherProfile> {
    return this.washerService.getProfile(user._id);
  }

  @Mutation(() => WasherProfile, { name: 'toggleWasherAvailability' })
  async toggleWasherAvailability(
    @CurrentUser() user: User,
  ): Promise<WasherProfile> {
    return this.washerService.toggleAvailability(user._id);
  }

  @Mutation(() => WasherProfile, { name: 'updateWasherProfile' })
  async updateWasherProfile(
    @Args('input') input: UpdateWasherProfileInput,
    @CurrentUser() user: User,
  ): Promise<WasherProfile> {
    return this.washerService.updateProfile(user._id, input);
  }

  @Query(() => WasherStats, { name: 'washerStats' })
  async getWasherStats(@CurrentUser() user: User): Promise<WasherStats> {
    return this.washerService.getStats(user._id);
  }

  /**
   * Her own performance over a date range — the Reports screen.
   *
   * Owner-scoped by construction: the uid comes from the token, and there is
   * deliberately no providerId/branchId argument, so one washer cannot ask for
   * another's numbers by guessing an id.
   */
  @Query(() => WasherReport, { name: 'washerReport' })
  async getWasherReport(
    @CurrentUser() user: User,
    @Args('dateFrom') dateFrom: string,
    @Args('dateTo') dateTo: string,
  ): Promise<WasherReport> {
    return this.washerService.getReport(user._id, dateFrom, dateTo);
  }

  // Certification evidence now goes to PRIVATE storage (RISK-P0-002): the
  // caller sends file bytes, never a public URL it uploaded itself. The old
  // `proofUrls` argument is retained only so pre-migration clients get a clear,
  // actionable error instead of a schema mismatch.
  @Mutation(() => Boolean, { name: 'submitCertificationProof' })
  async submitCertificationProof(
    @CurrentUser() user: User,
    @Args('proofs', { type: () => [CertificationProofInput], nullable: true })
    proofs?: CertificationProofInput[],
    @Args('proofUrls', { type: () => [String], nullable: true })
    proofUrls?: string[],
  ): Promise<boolean> {
    if (proofUrls?.length) {
      throw new BadRequestException(
        'Public certification proof URLs are no longer accepted. Upload the files with the `proofs` argument instead — evidence is stored privately.',
      );
    }
    return this.washerService.submitCertificationProof(user._id, proofs ?? []);
  }
}
