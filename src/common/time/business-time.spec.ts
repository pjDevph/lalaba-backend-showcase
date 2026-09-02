import {
  BUSINESS_TIME_ZONE,
  businessDayKey,
  businessWeekKey,
} from './business-time';

// These all pin the eight hours where Manila and UTC disagree about the date.
// A "once a day" campaign or a same-day booking cutoff that used UTC would be
// wrong every evening, which is exactly when people use the app.
describe('business time', () => {
  it('is Manila', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Manila');
  });

  describe('businessDayKey', () => {
    it('is already tomorrow in Manila when UTC is still yesterday evening', () => {
      // 2026-08-24 16:00 UTC = 2026-08-25 00:00 Manila
      expect(businessDayKey(new Date('2026-08-24T16:00:00Z'))).toBe(
        '2026-08-25',
      );
    });

    it('is still today in Manila one minute before that', () => {
      expect(businessDayKey(new Date('2026-08-24T15:59:00Z'))).toBe(
        '2026-08-24',
      );
    });

    it('does not roll over at UTC midnight', () => {
      // The bug a naive toISOString().slice(0,10) would produce: 08:00 Manila
      // on the 24th would be filed under the 24th correctly, but 00:30 UTC
      // (08:30 Manila) is the same Manila day, not a new one.
      expect(businessDayKey(new Date('2026-08-24T00:30:00Z'))).toBe(
        '2026-08-24',
      );
      expect(businessDayKey(new Date('2026-08-23T23:30:00Z'))).toBe(
        '2026-08-24',
      );
    });

    it('pads single-digit months and days', () => {
      expect(businessDayKey(new Date('2026-01-05T04:00:00Z'))).toBe(
        '2026-01-05',
      );
    });
  });

  describe('businessWeekKey', () => {
    it('gives the same key for every day of one Manila week', () => {
      // Mon 2026-08-24 through Sun 2026-08-30, sampled at Manila midday.
      const keys = [24, 25, 26, 27, 28, 29, 30].map((d) =>
        businessWeekKey(new Date(`2026-08-${d}T04:00:00Z`)),
      );
      expect(new Set(keys).size).toBe(1);
    });

    it('rolls to the next week on Manila Monday, not UTC Monday', () => {
      const sunday = businessWeekKey(new Date('2026-08-30T04:00:00Z'));
      const monday = businessWeekKey(new Date('2026-08-31T04:00:00Z'));
      expect(monday).not.toBe(sunday);
    });

    it('follows ISO rules across new year', () => {
      // 2026-12-31 is a Thursday, so it belongs to ISO week 53 of 2026, and
      // 2027-01-01 (Friday) is in that SAME week — not week 1 of 2027.
      const dec31 = businessWeekKey(new Date('2026-12-31T04:00:00Z'));
      const jan1 = businessWeekKey(new Date('2027-01-01T04:00:00Z'));
      expect(dec31).toBe('2026-W53');
      expect(jan1).toBe('2026-W53');
    });

    it('formats as YYYY-Www with a padded week number', () => {
      expect(businessWeekKey(new Date('2026-01-08T04:00:00Z'))).toMatch(
        /^\d{4}-W\d{2}$/,
      );
    });
  });
});
