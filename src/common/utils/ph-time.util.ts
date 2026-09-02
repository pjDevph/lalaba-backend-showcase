/**
 * Philippine-local calendar arithmetic.
 *
 * Every scheduling decision in this system is made in a customer's and a
 * provider's shared local day — "Monday", "same-day cutoff 4:00 PM", "book 14
 * days ahead" all mean PH-local, never UTC. Storing UTC instants and comparing
 * them against UTC calendar boundaries silently shifts the day for the eight
 * hours either side of midnight, which is exactly when a same-day cutoff or a
 * daily cap matters most.
 *
 * PH has no DST and has held UTC+8 since 1978, so a fixed offset is correct
 * rather than merely convenient — no tz database needed.
 */
export const PH_OFFSET_MS = 8 * 3600 * 1000;

/** UTC instant of PH-local midnight for the day `now` falls in. */
export function startOfTodayPH(now: number = Date.now()): Date {
  const nowInPH = new Date(now + PH_OFFSET_MS);
  return new Date(
    Date.UTC(
      nowInPH.getUTCFullYear(),
      nowInPH.getUTCMonth(),
      nowInPH.getUTCDate(),
    ) - PH_OFFSET_MS,
  );
}

/** PH-local calendar day key, e.g. '2026-08-14'. */
export function phDayKey(now: number = Date.now()): string {
  return new Date(now + PH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since PH-local midnight, e.g. 14:30 PH → 870. */
export function phMinutesOfDay(now: number = Date.now()): number {
  const nowInPH = new Date(now + PH_OFFSET_MS);
  return nowInPH.getUTCHours() * 60 + nowInPH.getUTCMinutes();
}

/**
 * Day-of-week key for a 'YYYY-MM-DD' day key, indexable into a weekly schedule.
 * Parsed as UTC so the result is the calendar day named by the string itself,
 * not the day that string lands on in the server's timezone.
 */
export const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

export function dayKeyOf(date: string): DayKey {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Not a calendar date: ${date}`);
  }
  return DAY_KEYS[parsed.getUTCDay()];
}

/** Whole PH-local days from `from` to `to`, both 'YYYY-MM-DD'. Negative if past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/** 'HH:MM' → minutes since midnight. NaN for anything malformed. */
export function parseHHMM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) return Number.NaN;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return Number.NaN;
  return h * 60 + m;
}

/** Minutes since midnight → 'HH:MM'. */
export function formatHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes since midnight → '8:00 AM', for labels the customer reads. */
export function formatHuman(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(m % 60).padStart(2, '0');
  return `${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** Adds whole days to a 'YYYY-MM-DD' key, returning the same format. */
export function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 'Mon, Aug 18' from a 'YYYY-MM-DD' key — the label snapshotted onto an order
 * so history renders without re-deriving it.
 *
 * Built from the key arithmetically rather than via toLocaleDateString: the key
 * is already PH-local, so handing it to a formatter that applies the server's
 * timezone would shift it by a day for servers west of Manila.
 */
const HUMAN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HUMAN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const weekday = HUMAN_DAYS[parsed.getUTCDay()];
  const month = HUMAN_MONTHS[parsed.getUTCMonth()];
  return `${weekday}, ${month} ${parsed.getUTCDate()}`;
}
