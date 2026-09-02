// src/common/time/business-time.ts
//
// One definition of when a day starts.
//
// The platform runs in the Philippines and its servers do not. Anything that
// asks "is this today?", "has this happened this week?", or "is it past the
// cutoff?" has to mean Manila time, or two features will disagree about which
// day it is for the eight hours between Manila midnight and UTC midnight —
// long enough for every evening booking and every evening app-open.
//
// `Asia/Manila` appeared in exactly one file before this. Anything with a day
// or week boundary should come through here instead of formatting its own.

/** PHT, UTC+08:00. The Philippines has no daylight saving, so this is a
 *  fixed offset — but it is expressed as a zone name so it stays correct if
 *  that ever stops being true. */
export const BUSINESS_TIME_ZONE = 'Asia/Manila';

/** en-CA gives ISO-shaped `YYYY-MM-DD` directly, with no manual padding. */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date in Manila, as `YYYY-MM-DD`. */
export function businessDayKey(at: Date = new Date()): string {
  return DAY_FORMAT.format(at);
}

/** Y/M/D as numbers, in Manila. */
export function businessDateParts(at: Date = new Date()): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = businessDayKey(at).split('-').map(Number);
  return { year, month, day };
}

/**
 * ISO-8601 week key in Manila, as `YYYY-Www`.
 *
 * ISO weeks run Monday–Sunday and belong to the year containing their
 * Thursday, which is why the last days of December can land in week 1 of the
 * following year. Getting that wrong would make a "once a week" campaign fire
 * twice across new year.
 */
export function businessWeekKey(at: Date = new Date()): string {
  const { year, month, day } = businessDateParts(at);
  // A UTC date carrying Manila's calendar values: from here on this is pure
  // calendar arithmetic, so the zone must not shift it again.
  const d = new Date(Date.UTC(year, month - 1, day));

  // Shift to the Thursday of this ISO week. getUTCDay() is 0=Sun, so map
  // Sunday to 7 to make Monday the start of the week.
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);

  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek);

  const week =
    1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
