import {
  addDays,
  dayKeyOf,
  daysBetween,
  formatHHMM,
  formatHuman,
  parseHHMM,
  phDayKey,
  phMinutesOfDay,
  startOfTodayPH,
} from './ph-time.util';

/** 2026-08-14 15:30 PH == 2026-08-14T07:30:00Z. */
const AUG_14_1530_PH = Date.parse('2026-08-14T07:30:00.000Z');

describe('PH calendar day', () => {
  it('names the PH day, not the UTC day', () => {
    // 2026-08-14 00:30 PH is still 2026-08-13 in UTC — the eight-hour window
    // where naive UTC math silently reports the wrong day.
    expect(phDayKey(Date.parse('2026-08-13T16:30:00.000Z'))).toBe('2026-08-14');
  });

  it('rolls over at PH midnight, not UTC midnight', () => {
    expect(phDayKey(Date.parse('2026-08-13T15:59:59.000Z'))).toBe('2026-08-13');
    expect(phDayKey(Date.parse('2026-08-13T16:00:00.000Z'))).toBe('2026-08-14');
  });

  it('anchors start-of-day to PH midnight', () => {
    expect(startOfTodayPH(AUG_14_1530_PH).toISOString()).toBe(
      '2026-08-13T16:00:00.000Z',
    );
  });

  it('reports minutes since PH midnight', () => {
    expect(phMinutesOfDay(AUG_14_1530_PH)).toBe(15 * 60 + 30);
  });
});

describe('dayKeyOf', () => {
  it('names the weekday of the date string itself', () => {
    expect(dayKeyOf('2026-08-14')).toBe('friday');
    expect(dayKeyOf('2026-08-16')).toBe('sunday');
  });

  it('rejects a string that is not a date', () => {
    expect(() => dayKeyOf('not-a-date')).toThrow();
  });
});

describe('daysBetween / addDays', () => {
  it('counts whole days forward', () => {
    expect(daysBetween('2026-08-14', '2026-08-28')).toBe(14);
  });

  it('returns a negative count for a past date', () => {
    expect(daysBetween('2026-08-14', '2026-08-13')).toBe(-1);
  });

  it('crosses a month boundary', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('time formatting', () => {
  it('parses HH:MM to minutes', () => {
    expect(parseHHMM('08:30')).toBe(510);
    expect(parseHHMM('00:00')).toBe(0);
  });

  it('rejects impossible clock times', () => {
    expect(parseHHMM('24:00')).toBeNaN();
    expect(parseHHMM('08:60')).toBeNaN();
    expect(parseHHMM('')).toBeNaN();
  });

  it('round-trips minutes back to HH:MM', () => {
    expect(formatHHMM(510)).toBe('08:30');
    expect(formatHHMM(0)).toBe('00:00');
  });

  it('renders 12-hour labels with the right meridiem', () => {
    expect(formatHuman(0)).toBe('12:00 AM');
    expect(formatHuman(12 * 60)).toBe('12:00 PM');
    expect(formatHuman(13 * 60 + 5)).toBe('1:05 PM');
    expect(formatHuman(20 * 60)).toBe('8:00 PM');
  });
});
