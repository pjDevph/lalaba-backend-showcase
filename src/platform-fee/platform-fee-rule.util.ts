import { BadRequestException } from '@nestjs/common';
import { ProviderType } from '../online-orders/schemas/order-status.enum';
import {
  FeeCalculationType,
  FeeChargedTo,
  FeePayerRole,
  PlatformFeeRule,
} from './schemas/platform-fee-rule.schema';

/**
 * Bump when the shape of a fee snapshot or the resolution/compute algorithm
 * changes — NOT when an admin edits a rate (that's the rule's own `version`).
 * Snapshotted onto orders alongside the rule key so an old order can be
 * re-explained under the code that priced it.
 */
export const FEE_RULE_ENGINE_VERSION = 'fee-rules-v1';

/** The payer role a provider-side fee is looked up under. */
export function payerRoleForProviderType(
  providerType: ProviderType,
): FeePayerRole {
  return providerType === ProviderType.WASHER
    ? FeePayerRole.HOME_WASHER
    : FeePayerRole.LAUNDROMAT;
}

/** `"Platform Commission"` + HOME_WASHER -> `"platform-commission-washer"`. */
export function feeRuleKeyFor(name: string, appliesTo: FeePayerRole): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'fee'}-${appliesTo}`;
}

/**
 * The fee a rule produces for a given base amount, with min/max applied.
 *
 * `baseCentavos` is only read by the percentage component — a FIXED rule on a
 * PER_ORDER basis ignores it entirely, which is why the caller passes 0 for
 * bases that have no monetary amount behind them (activation minimums).
 */
export function computeFeeCentavos(
  rule: Pick<
    PlatformFeeRule,
    | 'calculationType'
    | 'percent'
    | 'fixedAmountCentavos'
    | 'minFeeCentavos'
    | 'maxFeeCentavos'
  >,
  baseCentavos: number,
): number {
  const percentPart =
    rule.calculationType === FeeCalculationType.FIXED
      ? 0
      : baseCentavos * ((rule.percent ?? 0) / 100);
  const fixedPart =
    rule.calculationType === FeeCalculationType.PERCENTAGE
      ? 0
      : (rule.fixedAmountCentavos ?? 0);

  let fee = Math.round(percentPart + fixedPart);
  // Order matters: a max below the min would clamp up then down. validateRule()
  // rejects that combination, so by here min <= max and the order is moot —
  // min-then-max is written out anyway so a future edit can't reintroduce it.
  if (rule.minFeeCentavos != null) fee = Math.max(fee, rule.minFeeCentavos);
  if (rule.maxFeeCentavos != null) fee = Math.min(fee, rule.maxFeeCentavos);
  return fee;
}

/** True when `at` falls inside the rule's effective window and it is active. */
export function isRuleInEffect(
  rule: Pick<PlatformFeeRule, 'isActive' | 'effectiveFrom' | 'effectiveUntil'>,
  at: Date,
): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom.getTime() > at.getTime()) return false;
  if (rule.effectiveUntil && rule.effectiveUntil.getTime() <= at.getTime())
    return false;
  return true;
}

export interface FeeRuleDraft {
  name: string;
  calculationType: FeeCalculationType;
  percent?: number | null;
  fixedAmountCentavos?: number | null;
  minFeeCentavos?: number | null;
  maxFeeCentavos?: number | null;
  chargedTo: FeeChargedTo;
  customerSharePercent?: number | null;
  providerSharePercent?: number | null;
  applyVat?: boolean;
  vatRatePercent?: number | null;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
}

/**
 * Cross-field rules class-validator can't express (it validates one field at a
 * time). Financial config gets rejected loudly rather than silently coerced:
 * a percentage rule with no percentage would price every order at ₱0, and a
 * split that doesn't total 100% loses or invents money on every order.
 *
 * Throws on the FIRST problem rather than collecting all of them — the admin
 * form validates the same conditions client-side, so anything reaching here is
 * either a direct API call or a client bug, and neither benefits from a list.
 */
export function validateRule(draft: FeeRuleDraft): void {
  const needsPercent =
    draft.calculationType === FeeCalculationType.PERCENTAGE ||
    draft.calculationType === FeeCalculationType.FIXED_PLUS_PERCENTAGE;
  const needsFixed =
    draft.calculationType === FeeCalculationType.FIXED ||
    draft.calculationType === FeeCalculationType.FIXED_PLUS_PERCENTAGE;

  if (needsPercent && (draft.percent == null || draft.percent <= 0)) {
    throw new BadRequestException(
      'A percentage fee needs a percentage greater than 0.',
    );
  }
  if (
    needsFixed &&
    (draft.fixedAmountCentavos == null || draft.fixedAmountCentavos <= 0)
  ) {
    throw new BadRequestException(
      'A fixed fee needs an amount greater than ₱0.',
    );
  }
  // Reject rather than ignore: a leftover 12% on a rule the admin switched to
  // FIXED reads, in the history view, as though 12% were still in force.
  if (!needsPercent && draft.percent != null) {
    throw new BadRequestException(
      'This fee is a fixed amount — clear the percentage.',
    );
  }
  if (!needsFixed && draft.fixedAmountCentavos != null) {
    throw new BadRequestException(
      'This fee is a percentage — clear the fixed amount.',
    );
  }

  if (
    draft.minFeeCentavos != null &&
    draft.maxFeeCentavos != null &&
    draft.maxFeeCentavos < draft.minFeeCentavos
  ) {
    throw new BadRequestException(
      'Maximum fee must be greater than the minimum fee.',
    );
  }

  if (draft.chargedTo === FeeChargedTo.SPLIT) {
    const customer = draft.customerSharePercent;
    const provider = draft.providerSharePercent;
    if (customer == null || provider == null) {
      throw new BadRequestException(
        'A split fee needs both a customer share and a provider share.',
      );
    }
    if (Math.round(customer + provider) !== 100) {
      throw new BadRequestException('Allocation must total 100%.');
    }
  } else if (
    draft.customerSharePercent != null ||
    draft.providerSharePercent != null
  ) {
    throw new BadRequestException(
      'Shares only apply to a fee split between the customer and the provider.',
    );
  }

  if (
    draft.applyVat &&
    (draft.vatRatePercent == null || draft.vatRatePercent <= 0)
  ) {
    throw new BadRequestException('Applying VAT needs a VAT rate.');
  }

  if (
    draft.effectiveUntil &&
    draft.effectiveUntil.getTime() <= draft.effectiveFrom.getTime()
  ) {
    throw new BadRequestException('The end date must be after the start date.');
  }

  if (!draft.name.trim()) {
    throw new BadRequestException('A fee rule needs a name.');
  }
}
