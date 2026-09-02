import type { WasherProfile } from './schemas/washer-profile.schema';

/**
 * Last-resort label for a washer profile carrying no `storeName`.
 *
 * Deliberately generic. `storeName` is required at every write path — seeded at
 * registration (UsersService.createWasherShopAnchor), unclearable through
 * `updateWasherProfile`, and backfilled at rest by
 * migrations/washer-store-name-backfill.migration.ts — so this should be
 * unreachable. It exists because the alternative on an unreachable path is a
 * card with a BLANK name, and it is NOT her `displayName`: a home washer's shop
 * is never listed under her personal name.
 */
export const UNNAMED_WASHER_STORE_NAME = 'Home Laundry';

/**
 * The name a home washer's SHOP is listed and labelled under — the washer
 * equivalent of `Branch.branchName`.
 *
 * `storeName` is what she types on the washer app's Online Store screen. Her
 * `displayName` is her personal/legal name, used for KYC review and shown to
 * customers only as the separate "Operated by" line on her card; it is never a
 * substitute for the shop's name here.
 *
 * Shared rather than inlined so the customer's three views of the same shop —
 * discovery card/profile, order provider snapshot, chat thread — cannot drift
 * apart on which name they show.
 */
export function washerStoreName(
  washer: Pick<WasherProfile, 'displayName'> & { storeName?: string | null },
): string {
  return washer.storeName?.trim() || UNNAMED_WASHER_STORE_NAME;
}

/**
 * The shop name a newly-registered washer starts with, and the value the
 * backfill gives a profile that predates the field.
 *
 * Matches the anchor Branch's `branchName`, which has always been seeded this
 * way — so a washer's shop and her technical anchor branch agree from the
 * moment she registers, and she is never listed under a bare personal name
 * while she is still setting up.
 */
export function defaultWasherStoreName(firstName?: string | null): string {
  const trimmed = firstName?.trim();
  return trimmed ? `${trimmed}'s Laundry` : UNNAMED_WASHER_STORE_NAME;
}
