// src/campaigns/campaign-frequency.util.ts
//
// Frequency → the period key an impression is recorded under.
//
// Pure, because this is the whole rule: everything else is a unique index
// doing what the key tells it. "Once a week" being right or wrong is decided
// here and nowhere else.

import { CampaignFrequency } from './schemas/campaign.schema';
import { businessDayKey, businessWeekKey } from '../common/time/business-time';

/**
 * The minimum gap between two showings of an EVERY_APP_OPEN campaign.
 *
 * React Native reports foreground transitions more eagerly than a person would
 * call them "opening the app" — a notification tap, a permission sheet, or a
 * return from the camera can each produce one. Without a floor, "every app
 * open" reads to the user as "constantly".
 *
 * Not admin-configurable. It protects people from a misconfiguration, so
 * putting it behind the same admin panel that could cause one would defeat it.
 */
export const APP_OPEN_FLOOR_MINUTES = 30;

/** Periodic impressions are disposable once their window is long past. */
export const PERIODIC_IMPRESSION_RETENTION_DAYS = 180;

export class MissingSessionIdError extends Error {
  constructor() {
    super('EVERY_LOGIN campaigns need a session id');
    this.name = 'MissingSessionIdError';
  }
}

/**
 * The key identifying "this showing window" for an account.
 *
 * EVERY_LOGIN takes the client's session id — untrusted, but the worst a
 * forged one buys is seeing an advertisement again, and there is no reward
 * attached to that. EVERY_APP_OPEN is bucketed SERVER-side from the clock so
 * the client cannot choose its own window at all; the floor check in the
 * service is what actually enforces the interval, and this key exists so two
 * concurrent requests in one bucket still collide on the unique index.
 */
export function periodKeyFor(
  frequency: CampaignFrequency,
  now: Date,
  sessionId?: string | null,
): string {
  switch (frequency) {
    case CampaignFrequency.ONCE_EVER:
      return 'lifetime';
    case CampaignFrequency.DAILY:
      return `day:${businessDayKey(now)}`;
    case CampaignFrequency.WEEKLY:
      return `week:${businessWeekKey(now)}`;
    case CampaignFrequency.EVERY_LOGIN: {
      const trimmed = sessionId?.trim();
      if (!trimmed) throw new MissingSessionIdError();
      return `login:${trimmed}`;
    }
    case CampaignFrequency.EVERY_APP_OPEN: {
      const bucket = Math.floor(
        now.getTime() / (APP_OPEN_FLOOR_MINUTES * 60_000),
      );
      return `open:${bucket}`;
    }
  }

  // Unreachable while the switch is exhaustive — and the `never` is what makes
  // adding a frequency without a key a compile error rather than a campaign
  // that silently shows on every single request.
  const unhandled: never = frequency;
  throw new Error(`Unsupported campaign frequency: ${String(unhandled)}`);
}

/**
 * When an impression may be swept, or null to keep it forever.
 *
 * ONCE_EVER must never expire: the row IS the record that this account has
 * already had its one showing, so deleting it re-shows the campaign.
 */
export function impressionExpiryFor(
  frequency: CampaignFrequency,
  now: Date,
): Date | null {
  if (frequency === CampaignFrequency.ONCE_EVER) return null;
  return new Date(
    now.getTime() + PERIODIC_IMPRESSION_RETENTION_DAYS * 86_400_000,
  );
}
