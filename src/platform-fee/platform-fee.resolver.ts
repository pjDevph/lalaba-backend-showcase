import { Resolver, Query, Mutation, Args, Float, Int } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PlatformFeeService } from './platform-fee.service';
import { PlatformFeeConfig } from './schemas/platform-fee-config.schema';
import { PlatformFeeRule } from './schemas/platform-fee-rule.schema';
import { FeeRulePreview } from './models/fee-rule-preview.model';
import { EffectiveCommission } from './models/effective-commission.model';
import { PlatformStatsToday } from './models/platform-stats-today.model';
import { SetPlatformFeeInput } from './dto/set-platform-fee.input';
import { SavePlatformFeeRuleInput } from './dto/save-platform-fee-rule.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';
import { ProviderType } from '../online-orders/schemas/order-status.enum';

/** Sensible default for the admin preview: a ₱500 order. */
const DEFAULT_PREVIEW_BASE_CENTAVOS = 50_000;

@Resolver(() => PlatformFeeRule)
@Roles('admin')
@UseGuards(GqlAuthGuard, RolesGuard)
export class PlatformFeeResolver {
  constructor(private readonly platformFeeService: PlatformFeeService) {}

  // ── Reads available to every role ────────────────────────────────────────
  // The commission is already baked into every price a customer sees
  // (DiscoveryService.markup), and a washer setting her own price needs the
  // same number to preview what the customer will be charged. Hardcoding it in
  // the apps was the alternative, and it silently goes wrong the day the rate
  // changes.

  /**
   * What THIS provider's commission actually is, in terms their app can render
   * without guessing.
   *
   * Provider-callable on purpose, and deliberately not `platformFeeRules`:
   * that returns whole rule documents for every payer and is admin-only.
   * This is a projection of one rule - the caller's own - carrying just the
   * rate, who pays it, and whether a percentage describes it.
   *
   * Customers are excluded. The commission is a term between the platform and
   * the provider; what a customer pays is the order total, which the quote
   * already tells them.
   */
  @Roles('admin', 'support', 'merchant', 'washer', 'staff')
  @Query(() => EffectiveCommission, { name: 'myEffectiveCommission' })
  async myEffectiveCommission(
    @Args('providerType', { type: () => ProviderType })
    providerType: ProviderType,
  ): Promise<EffectiveCommission> {
    return this.platformFeeService.getEffectiveCommission(providerType);
  }

  @Roles('admin', 'support', 'merchant', 'washer', 'staff', 'customer')
  @Query(() => Float, { name: 'currentPlatformFeePercent' })
  async currentPlatformFeePercent(
    // Optional so the pre-split apps keep working unchanged; without it the
    // home-washer rate is returned, which is what those clients were already
    // getting when there was only one rate.
    @Args('providerType', { type: () => ProviderType, nullable: true })
    providerType?: ProviderType,
  ): Promise<number> {
    return this.platformFeeService.getCommissionPercent(
      providerType ?? ProviderType.WASHER,
    );
  }

  // ── Admin: dashboard ─────────────────────────────────────────────────────

  @Roles('admin', 'support')
  @Query(() => PlatformStatsToday, { name: 'platformStatsToday' })
  async platformStatsToday(): Promise<PlatformStatsToday> {
    return this.platformFeeService.statsToday();
  }

  // ── Admin: rules ─────────────────────────────────────────────────────────

  @Query(() => [PlatformFeeRule], { name: 'platformFeeRules' })
  async platformFeeRules(): Promise<PlatformFeeRule[]> {
    return this.platformFeeService.listRules();
  }

  @Query(() => [PlatformFeeRule], { name: 'platformFeeRuleHistory' })
  async platformFeeRuleHistory(
    @Args('ruleKey') ruleKey: string,
  ): Promise<PlatformFeeRule[]> {
    return this.platformFeeService.ruleHistory(ruleKey);
  }

  /**
   * Computed server-side from an unsaved draft so the number the admin
   * approves is produced by the same code that will price the orders.
   */
  @Query(() => FeeRulePreview, { name: 'previewPlatformFeeRule' })
  previewPlatformFeeRule(
    @Args('input') input: SavePlatformFeeRuleInput,
    @Args('baseCentavos', { type: () => Int, nullable: true })
    baseCentavos?: number,
  ): FeeRulePreview {
    return this.platformFeeService.previewRule(
      input,
      baseCentavos ?? DEFAULT_PREVIEW_BASE_CENTAVOS,
    );
  }

  @Mutation(() => PlatformFeeRule)
  async createPlatformFeeRule(
    @Args('input') input: SavePlatformFeeRuleInput,
    @CurrentUser() user: User,
  ): Promise<PlatformFeeRule> {
    return this.platformFeeService.createRule(
      input,
      user._id,
      adminNameOf(user),
    );
  }

  /** Publishes a new version — the previous one stays readable forever. */
  @Mutation(() => PlatformFeeRule)
  async updatePlatformFeeRule(
    @Args('ruleKey') ruleKey: string,
    @Args('input') input: SavePlatformFeeRuleInput,
    @CurrentUser() user: User,
  ): Promise<PlatformFeeRule> {
    return this.platformFeeService.updateRule(
      ruleKey,
      input,
      user._id,
      adminNameOf(user),
    );
  }

  @Mutation(() => PlatformFeeRule)
  async setPlatformFeeRuleActive(
    @Args('ruleKey') ruleKey: string,
    @Args('isActive') isActive: boolean,
    @CurrentUser() user: User,
    @Args('changeReason', { nullable: true }) changeReason?: string,
  ): Promise<PlatformFeeRule> {
    return this.platformFeeService.setRuleActive(
      ruleKey,
      isActive,
      user._id,
      adminNameOf(user),
      changeReason,
    );
  }

  /**
   * Creates the starting rule set on an environment that has none, carrying
   * the old global rate across unchanged. Idempotent, so it is safe to hit
   * from the admin panel's empty state rather than needing a shell script.
   */
  @Mutation(() => [String], { name: 'seedPlatformFeeRules' })
  async seedPlatformFeeRules(@CurrentUser() user: User): Promise<string[]> {
    return this.platformFeeService.seedDefaultRules(user._id);
  }

  // ── Legacy, kept until every client is on the rules API ──────────────────

  /** @deprecated Superseded by platformFeeRuleHistory(ruleKey). */
  @Query(() => [PlatformFeeConfig], { name: 'platformFeeHistory' })
  async platformFeeHistory(): Promise<PlatformFeeConfig[]> {
    return this.platformFeeService.history();
  }

  /** @deprecated Superseded by updatePlatformFeeRule. */
  @Mutation(() => PlatformFeeConfig)
  async setPlatformFee(
    @Args('input') input: SetPlatformFeeInput,
    @CurrentUser() user: User,
  ): Promise<PlatformFeeConfig> {
    return this.platformFeeService.setFeePercent(input.feePercent, user._id);
  }
}

/**
 * A display name for the history panel, snapshotted onto the version so it
 * still renders after the admin leaves the company and their user record is
 * anonymised by account deletion.
 */
function adminNameOf(user: User): string | undefined {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || undefined;
}
