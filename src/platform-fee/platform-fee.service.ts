import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PlatformFeeConfig,
  PlatformFeeConfigDocument,
} from './schemas/platform-fee-config.schema';
import {
  FeeBasis,
  FeeCalculationType,
  FeeCategory,
  FeeChargedTo,
  FeeDeductionSource,
  FeePayerRole,
  FeeTaxTreatment,
  PlatformFeeRule,
  PlatformFeeRuleDocument,
} from './schemas/platform-fee-rule.schema';
import {
  computeFeeCentavos,
  FEE_RULE_ENGINE_VERSION,
  feeRuleKeyFor,
  isRuleInEffect,
  payerRoleForProviderType,
  validateRule,
  type FeeRuleDraft,
} from './platform-fee-rule.util';
import { FeeRulePreview } from './models/fee-rule-preview.model';
import { EffectiveCommission } from './models/effective-commission.model';
import { PlatformStatsToday } from './models/platform-stats-today.model';
import {
  OnlineOrder,
  OnlineOrderDocument,
} from '../online-orders/schemas/online-order.schema';
import {
  OrderStatus,
  ProviderType,
} from '../online-orders/schemas/order-status.enum';
import { SavePlatformFeeRuleInput } from './dto/save-platform-fee-rule.input';

/**
 * The rate every provider was on before per-payer rules existed. Used only
 * when no commission rule resolves at all — an empty database on a fresh
 * environment, or a rule scheduled to start in the future with nothing before
 * it. Returning 0 in that case would silently make the platform free.
 */
const DEFAULT_COMMISSION_PERCENT = 10;

@Injectable()
export class PlatformFeeService {
  private readonly logger = new Logger(PlatformFeeService.name);

  constructor(
    @InjectModel(PlatformFeeRule.name)
    private readonly ruleModel: Model<PlatformFeeRuleDocument>,
    @InjectModel(PlatformFeeConfig.name)
    private readonly legacyConfigModel: Model<PlatformFeeConfigDocument>,
    @InjectModel(OnlineOrder.name)
    private readonly onlineOrderModel: Model<OnlineOrderDocument>,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Resolution — what the pricing code calls
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The rule in force for a payer + category at `at`, or null.
   *
   * "In force" is the highest VERSION whose effective window contains `at` —
   * not simply the newest document. Those differ whenever a change is
   * scheduled ahead: version 3 dated Sep 1 exists in the collection all
   * through August, and must not be picked up until September.
   */
  async resolveRule(
    appliesTo: FeePayerRole,
    category: FeeCategory,
    at: Date = new Date(),
  ): Promise<PlatformFeeRuleDocument | null> {
    const candidates = await this.ruleModel
      .find({ appliesTo, category, effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1, version: -1 })
      .exec();

    // One rule per (payer, category) today — no day/time or per-service
    // overrides exist yet, so there is nothing to break ties between beyond
    // "most recently effective". When overrides land, the precedence chain
    // goes here and `stackable` starts being read.
    const byKey = new Map<string, PlatformFeeRuleDocument>();
    for (const rule of candidates) {
      if (!byKey.has(rule.ruleKey)) byKey.set(rule.ruleKey, rule);
    }
    for (const rule of byKey.values()) {
      if (isRuleInEffect(rule, at)) return rule;
    }
    return null;
  }

  /**
   * The commission a provider of this type is on right now, with the terms
   * their own app needs to explain it: the rate, who pays it, and whether a
   * percentage describes it at all.
   *
   * Exists because `getCommissionPercent` returns a bare number, and a number
   * alone cannot answer the only question a provider actually asks - "so what
   * do I get?". Answering it in the app meant hardcoding an assumption about
   * `chargedTo` that nothing enforces.
   */
  async getEffectiveCommission(
    providerType: ProviderType,
    at: Date = new Date(),
  ): Promise<EffectiveCommission> {
    const rule = await this.resolveRule(
      payerRoleForProviderType(providerType),
      FeeCategory.COMMISSION,
      at,
    );

    if (rule && rule.calculationType !== FeeCalculationType.FIXED) {
      return {
        percent: rule.percent ?? 0,
        chargedTo: rule.chargedTo,
        calculationType: rule.calculationType,
        isConfigured: true,
      };
    }

    // No usable rule: report the fallback rate, but say it is not a configured
    // term. CUSTOMER is the platform's historical behaviour and matches both
    // seeded rules, so it is the honest default to report - but isConfigured
    // false tells the client not to quote it as though someone chose it.
    return {
      percent: await this.legacyFeePercent(),
      chargedTo: FeeChargedTo.CUSTOMER,
      calculationType: FeeCalculationType.PERCENTAGE,
      isConfigured: false,
    };
  }

  /**
   * The commission percentage a provider of this type pays right now.
   *
   * Falls back through: the payer's COMMISSION rule -> the legacy global
   * PlatformFeeConfig -> 10%. The legacy step matters for any environment whose
   * database predates the migration; it can be dropped once every environment
   * has run it.
   */
  async getCommissionPercent(
    providerType: ProviderType,
    at: Date = new Date(),
  ): Promise<number> {
    const rule = await this.resolveRule(
      payerRoleForProviderType(providerType),
      FeeCategory.COMMISSION,
      at,
    );
    if (rule) {
      // A commission stored as FIXED has no percentage to report. The callers
      // of this method (discovery markup, order pricing) are all
      // percentage-shaped, so a fixed commission is not yet expressible — the
      // form allows only PERCENTAGE for COMMISSION to keep that honest.
      if (rule.calculationType === FeeCalculationType.FIXED) {
        this.logger.warn(
          `Commission rule ${rule.ruleKey} v${rule.version} is a fixed amount; percentage callers cannot use it. Falling back.`,
        );
      } else {
        return rule.percent ?? 0;
      }
    }
    return this.legacyFeePercent();
  }

  /**
   * The commission rate PLUS the identity of the rule it came from, for
   * snapshotting onto an order.
   *
   * Storing the percentage alone already keeps an order's arithmetic stable,
   * which is what the existing snapshot does. What it cannot answer is "which
   * rule, on what terms, priced this" — and that is the question an audit or a
   * disputed settlement actually asks a year later, once several rules have
   * carried the same rate at different times. `ruleKey` is null on an
   * unmigrated environment, where the rate came from the legacy global config.
   */
  async resolveCommissionSnapshot(
    providerType: ProviderType,
    at: Date = new Date(),
  ): Promise<{
    percent: number;
    ruleKey: string | null;
    ruleVersion: number | null;
    engineVersion: string;
  }> {
    const rule = await this.resolveRule(
      payerRoleForProviderType(providerType),
      FeeCategory.COMMISSION,
      at,
    );
    const usable = rule && rule.calculationType !== FeeCalculationType.FIXED;
    return {
      percent: usable ? (rule.percent ?? 0) : await this.legacyFeePercent(),
      ruleKey: usable ? rule.ruleKey : null,
      ruleVersion: usable ? rule.version : null,
      engineVersion: FEE_RULE_ENGINE_VERSION,
    };
  }

  /**
   * The pre-rules global rate. Kept for callers that have no provider in hand
   * and for the migration's starting value.
   *
   * @deprecated Prefer getCommissionPercent(providerType) — a single global
   * rate cannot express the washer/merchant split the rules now support.
   */
  async getCurrentFeePercent(): Promise<number> {
    return this.getCommissionPercent(ProviderType.WASHER);
  }

  private async legacyFeePercent(): Promise<number> {
    const current = await this.legacyConfigModel
      .findOne({ effectiveFrom: { $lte: new Date() } })
      .sort({ effectiveFrom: -1 })
      .exec();
    return current?.feePercent ?? DEFAULT_COMMISSION_PERCENT;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admin reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Platform-wide commission collected from orders completed today (PH time),
   * for the admin dashboard. Not scoped to any merchant/branch/provider.
   */
  async statsToday(): Promise<PlatformStatsToday> {
    const [result] = await this.onlineOrderModel
      .aggregate([
        {
          $match: {
            status: OrderStatus.COMPLETED,
            $expr: {
              $eq: [
                {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: '$completedAt',
                    timezone: '+08:00',
                  },
                },
                {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: new Date(),
                    timezone: '+08:00',
                  },
                },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            revenueCentavos: { $sum: '$pricing.platformFeeCentavos' },
            completedOrders: { $sum: 1 },
          },
        },
      ])
      .exec();
    return {
      revenueCentavos: Math.round(result?.revenueCentavos ?? 0),
      completedOrders: result?.completedOrders ?? 0,
    };
  }

  /** The newest version of every rule — one row per rule, for the admin table. */
  async listRules(): Promise<PlatformFeeRuleDocument[]> {
    const all = await this.ruleModel
      .find()
      .sort({ ruleKey: 1, version: -1 })
      .exec();
    const latest = new Map<string, PlatformFeeRuleDocument>();
    for (const rule of all) {
      if (!latest.has(rule.ruleKey)) latest.set(rule.ruleKey, rule);
    }
    return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every version of one rule, newest first — the change-history panel. */
  async ruleHistory(ruleKey: string): Promise<PlatformFeeRuleDocument[]> {
    const versions = await this.ruleModel
      .find({ ruleKey })
      .sort({ version: -1 })
      .exec();
    if (!versions.length) {
      throw new NotFoundException('No fee rule with that key.');
    }
    return versions;
  }

  /**
   * A preview of an UNSAVED draft. Takes the same input as the save mutation
   * so the admin sees the effect of exactly what they are about to publish,
   * and validates it first so an invalid draft reports the validation error
   * rather than a nonsense number.
   */
  previewRule(
    input: SavePlatformFeeRuleInput,
    baseCentavos: number,
  ): FeeRulePreview {
    validateRule(this.toDraft(input));

    const uncapped = computeFeeCentavos(
      { ...input, minFeeCentavos: null, maxFeeCentavos: null },
      baseCentavos,
    );
    const fee = computeFeeCentavos(input, baseCentavos);

    const customerShare =
      input.chargedTo === FeeChargedTo.CUSTOMER
        ? fee
        : input.chargedTo === FeeChargedTo.PROVIDER
          ? 0
          : Math.round(fee * ((input.customerSharePercent ?? 0) / 100));
    // The remainder rather than a second rounding, so the two shares always
    // add back to exactly `fee` — a 1-centavo rounding gap here becomes an
    // unbalanced ledger downstream.
    const providerShare = fee - customerShare;

    const vat =
      input.applyVat && input.taxTreatment === FeeTaxTreatment.TAX_EXCLUSIVE
        ? Math.round(fee * ((input.vatRatePercent ?? 0) / 100))
        : 0;

    return {
      baseCentavos,
      feeCentavos: fee,
      uncappedFeeCentavos: uncapped,
      minimumApplied:
        input.minFeeCentavos != null && uncapped < input.minFeeCentavos,
      maximumApplied:
        input.maxFeeCentavos != null && uncapped > input.maxFeeCentavos,
      vatCentavos: vat,
      customerShareCentavos: customerShare,
      providerShareCentavos: providerShare,
      customerTotalCentavos: baseCentavos + customerShare + vat,
      providerEarningsCentavos: baseCentavos - providerShare,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admin writes — every one of these INSERTS, none update in place
  // ───────────────────────────────────────────────────────────────────────────

  async createRule(
    input: SavePlatformFeeRuleInput,
    adminUid: string,
    adminName?: string,
  ): Promise<PlatformFeeRuleDocument> {
    validateRule(this.toDraft(input));
    const ruleKey = feeRuleKeyFor(input.name, input.appliesTo);

    const existing = await this.ruleModel.exists({ ruleKey });
    if (existing) {
      throw new BadRequestException(
        `A fee named "${input.name}" already exists for this payer. Edit it instead — editing publishes a new version and keeps the history.`,
      );
    }

    return this.ruleModel.create({
      ...input,
      ruleKey,
      version: 1,
      setByUid: adminUid,
      setByName: adminName,
    });
  }

  /**
   * Publishes version N+1 of an existing rule. The previous version is left
   * untouched apart from a `supersededByVersion` marker — orders priced under
   * it must keep resolving to its exact terms.
   */
  async updateRule(
    ruleKey: string,
    input: SavePlatformFeeRuleInput,
    adminUid: string,
    adminName?: string,
  ): Promise<PlatformFeeRuleDocument> {
    validateRule(this.toDraft(input));

    const current = await this.ruleModel
      .findOne({ ruleKey })
      .sort({ version: -1 })
      .exec();
    if (!current) throw new NotFoundException('No fee rule with that key.');

    // Both are part of the rule's identity: the pricing code looks a rule up
    // BY payer and category, so changing either would make every past version
    // of this key describe a fee that no longer exists.
    if (input.appliesTo !== current.appliesTo) {
      throw new BadRequestException(
        'A fee rule cannot change who it applies to. Create a separate rule for the other payer.',
      );
    }
    if (input.category !== current.category) {
      throw new BadRequestException(
        'A fee rule cannot change category. Create a separate rule instead.',
      );
    }

    const nextVersion = current.version + 1;
    const published = await this.ruleModel.create({
      ...input,
      ruleKey,
      version: nextVersion,
      setByUid: adminUid,
      setByName: adminName,
    });

    await this.ruleModel
      .updateOne(
        { _id: current._id },
        { $set: { supersededByVersion: nextVersion } },
      )
      .exec();

    return published;
  }

  /**
   * Activate/deactivate. Also a new version rather than a flag flip, because
   * "who switched this off, and when" is exactly the question an audit asks.
   */
  async setRuleActive(
    ruleKey: string,
    isActive: boolean,
    adminUid: string,
    adminName?: string,
    changeReason?: string,
  ): Promise<PlatformFeeRuleDocument> {
    const current = await this.ruleModel
      .findOne({ ruleKey })
      .sort({ version: -1 })
      .exec();
    if (!current) throw new NotFoundException('No fee rule with that key.');

    const input = {
      ...this.toSaveInput(current),
      isActive,
      effectiveFrom: new Date(),
      changeReason:
        changeReason ?? (isActive ? 'Rule reactivated' : 'Rule deactivated'),
    };
    return this.updateRule(current.ruleKey, input, adminUid, adminName);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Legacy surface — kept so nothing breaks mid-migration
  // ───────────────────────────────────────────────────────────────────────────

  /** @deprecated Use createRule/updateRule. Writes the pre-rules global config. */
  async setFeePercent(
    feePercent: number,
    adminUid: string,
  ): Promise<PlatformFeeConfig> {
    return this.legacyConfigModel.create({
      feePercent,
      effectiveFrom: new Date(),
      setByUid: adminUid,
    });
  }

  /** @deprecated Use ruleHistory(ruleKey). */
  async history(): Promise<PlatformFeeConfig[]> {
    return this.legacyConfigModel.find().sort({ effectiveFrom: -1 }).exec();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Seeding
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Creates the starting rule set on an environment that has none, carrying
   * the legacy global percentage across as BOTH provider commissions so the
   * migration changes no prices. Idempotent: skips any rule key that exists,
   * so re-running after an admin has edited a rate leaves the edit alone.
   *
   * Returns the keys it created, so the caller can log a real result rather
   * than "done".
   */
  async seedDefaultRules(adminUid = 'system'): Promise<string[]> {
    const legacyPercent = await this.legacyFeePercent();
    const now = new Date();

    const defaults: SavePlatformFeeRuleInput[] = [
      {
        name: 'Platform Commission',
        description:
          'Platform fee added to the service price and shown to the customer as a separate line.',
        appliesTo: FeePayerRole.HOME_WASHER,
        category: FeeCategory.COMMISSION,
        calculationType: FeeCalculationType.PERCENTAGE,
        percent: legacyPercent,
        fixedAmountCentavos: null,
        basis: FeeBasis.SERVICE_SUBTOTAL,
        minFeeCentavos: null,
        maxFeeCentavos: null,
        chargedTo: FeeChargedTo.CUSTOMER,
        customerSharePercent: null,
        providerSharePercent: null,
        deductFrom: FeeDeductionSource.NOT_DEDUCTED,
        taxTreatment: FeeTaxTreatment.TAX_INCLUSIVE,
        applyVat: false,
        vatRatePercent: null,
        stackable: true,
        isActive: true,
        effectiveFrom: now,
        effectiveUntil: null,
        changeReason: 'Migrated from the global platform fee setting.',
      },
      {
        name: 'Platform Commission',
        description:
          'Platform fee added to the service price and shown to the customer as a separate line.',
        appliesTo: FeePayerRole.LAUNDROMAT,
        category: FeeCategory.COMMISSION,
        calculationType: FeeCalculationType.PERCENTAGE,
        percent: legacyPercent,
        fixedAmountCentavos: null,
        basis: FeeBasis.SERVICE_SUBTOTAL,
        minFeeCentavos: null,
        maxFeeCentavos: null,
        chargedTo: FeeChargedTo.CUSTOMER,
        customerSharePercent: null,
        providerSharePercent: null,
        deductFrom: FeeDeductionSource.NOT_DEDUCTED,
        taxTreatment: FeeTaxTreatment.TAX_INCLUSIVE,
        applyVat: false,
        vatRatePercent: null,
        stackable: true,
        isActive: true,
        effectiveFrom: now,
        effectiveUntil: null,
        changeReason: 'Migrated from the global platform fee setting.',
      },
      // The wallet thresholds from wallet.constants.ts. Not charges — the money
      // stays the provider's — but they are the amounts an admin most often
      // wants to change, and they were previously only changeable by deploying.
      ...[FeePayerRole.HOME_WASHER, FeePayerRole.LAUNDROMAT].flatMap(
        (payer) => [
          {
            name: 'Activation Minimum',
            description:
              'Wallet balance a provider must reach once before going live. Not charged — the balance stays theirs.',
            appliesTo: payer,
            category: FeeCategory.ACTIVATION_MINIMUM,
            calculationType: FeeCalculationType.FIXED,
            percent: null,
            fixedAmountCentavos: 100_000,
            basis: FeeBasis.ONE_TIME_ACTIVATION,
            minFeeCentavos: null,
            maxFeeCentavos: null,
            chargedTo: FeeChargedTo.PROVIDER,
            customerSharePercent: null,
            providerSharePercent: null,
            deductFrom: FeeDeductionSource.NOT_DEDUCTED,
            taxTreatment: FeeTaxTreatment.TAX_INCLUSIVE,
            applyVat: false,
            vatRatePercent: null,
            stackable: false,
            isActive: true,
            effectiveFrom: now,
            effectiveUntil: null,
            changeReason: 'Migrated from wallet.constants.ts.',
          },
          {
            name: 'Accept Booking Minimum',
            description:
              'Wallet balance a provider must keep to stay visible in discovery. Not charged.',
            appliesTo: payer,
            category: FeeCategory.ACCEPT_MINIMUM,
            calculationType: FeeCalculationType.FIXED,
            percent: null,
            fixedAmountCentavos: 10_000,
            basis: FeeBasis.PER_PROVIDER,
            minFeeCentavos: null,
            maxFeeCentavos: null,
            chargedTo: FeeChargedTo.PROVIDER,
            customerSharePercent: null,
            providerSharePercent: null,
            deductFrom: FeeDeductionSource.NOT_DEDUCTED,
            taxTreatment: FeeTaxTreatment.TAX_INCLUSIVE,
            applyVat: false,
            vatRatePercent: null,
            stackable: false,
            isActive: true,
            effectiveFrom: now,
            effectiveUntil: null,
            changeReason: 'Migrated from wallet.constants.ts.',
          },
        ],
      ),
    ];

    const created: string[] = [];
    for (const def of defaults) {
      const ruleKey = feeRuleKeyFor(def.name, def.appliesTo);
      if (await this.ruleModel.exists({ ruleKey })) continue;
      await this.ruleModel.create({
        ...def,
        ruleKey,
        version: 1,
        setByUid: adminUid,
        setByName: 'Migration',
      });
      created.push(ruleKey);
    }
    return created;
  }

  // ───────────────────────────────────────────────────────────────────────────

  private toDraft(input: SavePlatformFeeRuleInput): FeeRuleDraft {
    return {
      name: input.name,
      calculationType: input.calculationType,
      percent: input.percent,
      fixedAmountCentavos: input.fixedAmountCentavos,
      minFeeCentavos: input.minFeeCentavos,
      maxFeeCentavos: input.maxFeeCentavos,
      chargedTo: input.chargedTo,
      customerSharePercent: input.customerSharePercent,
      providerSharePercent: input.providerSharePercent,
      applyVat: input.applyVat,
      vatRatePercent: input.vatRatePercent,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil,
    };
  }

  /** A stored version re-expressed as save input, for republish-with-one-change. */
  private toSaveInput(rule: PlatformFeeRuleDocument): SavePlatformFeeRuleInput {
    return {
      name: rule.name,
      description: rule.description ?? undefined,
      appliesTo: rule.appliesTo,
      category: rule.category,
      calculationType: rule.calculationType,
      percent: rule.percent ?? null,
      fixedAmountCentavos: rule.fixedAmountCentavos ?? null,
      basis: rule.basis,
      minFeeCentavos: rule.minFeeCentavos ?? null,
      maxFeeCentavos: rule.maxFeeCentavos ?? null,
      chargedTo: rule.chargedTo,
      customerSharePercent: rule.customerSharePercent ?? null,
      providerSharePercent: rule.providerSharePercent ?? null,
      deductFrom: rule.deductFrom,
      taxTreatment: rule.taxTreatment,
      applyVat: rule.applyVat,
      vatRatePercent: rule.vatRatePercent ?? null,
      stackable: rule.stackable,
      isActive: rule.isActive,
      effectiveFrom: rule.effectiveFrom,
      effectiveUntil: rule.effectiveUntil ?? null,
      changeReason: rule.changeReason ?? undefined,
    };
  }
}
