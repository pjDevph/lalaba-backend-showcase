import {
  APP_OPEN_FLOOR_MINUTES,
  MissingSessionIdError,
  impressionExpiryFor,
  periodKeyFor,
} from './campaign-frequency.util';
import { CampaignFrequency } from './schemas/campaign.schema';

const at = (iso: string) => new Date(iso);

describe('periodKeyFor', () => {
  it('ONCE_EVER is one window forever', () => {
    expect(
      periodKeyFor(CampaignFrequency.ONCE_EVER, at('2026-08-24T04:00:00Z')),
    ).toBe(
      periodKeyFor(CampaignFrequency.ONCE_EVER, at('2027-01-01T04:00:00Z')),
    );
  });

  it('DAILY buckets by the MANILA day, not the UTC day', () => {
    // 15:59Z is still the 24th in Manila; 16:00Z is the 25th.
    const before = periodKeyFor(
      CampaignFrequency.DAILY,
      at('2026-08-24T15:59:00Z'),
    );
    const after = periodKeyFor(
      CampaignFrequency.DAILY,
      at('2026-08-24T16:00:00Z'),
    );
    expect(before).toBe('day:2026-08-24');
    expect(after).toBe('day:2026-08-25');
  });

  it('WEEKLY holds across a Manila week', () => {
    const mon = periodKeyFor(
      CampaignFrequency.WEEKLY,
      at('2026-08-24T04:00:00Z'),
    );
    const sun = periodKeyFor(
      CampaignFrequency.WEEKLY,
      at('2026-08-30T04:00:00Z'),
    );
    expect(mon).toBe(sun);
  });

  it('EVERY_LOGIN keys on the session', () => {
    const now = at('2026-08-24T04:00:00Z');
    expect(periodKeyFor(CampaignFrequency.EVERY_LOGIN, now, 'sess-1')).toBe(
      'login:sess-1',
    );
    expect(periodKeyFor(CampaignFrequency.EVERY_LOGIN, now, 'sess-2')).toBe(
      'login:sess-2',
    );
  });

  it('EVERY_LOGIN refuses to invent a window when no session is given', () => {
    // Falling back to a shared key would make one person's login suppress
    // everyone else's, so this is deliberately an error the caller handles.
    const now = at('2026-08-24T04:00:00Z');
    expect(() => periodKeyFor(CampaignFrequency.EVERY_LOGIN, now)).toThrow(
      MissingSessionIdError,
    );
    expect(() =>
      periodKeyFor(CampaignFrequency.EVERY_LOGIN, now, '   '),
    ).toThrow(MissingSessionIdError);
  });

  it('EVERY_APP_OPEN buckets server-side, so the client cannot pick its window', () => {
    const a = periodKeyFor(
      CampaignFrequency.EVERY_APP_OPEN,
      at('2026-08-24T04:00:00Z'),
      'client-chosen',
    );
    const b = periodKeyFor(
      CampaignFrequency.EVERY_APP_OPEN,
      at('2026-08-24T04:10:00Z'),
      'different',
    );
    // Same bucket despite different client input.
    expect(a).toBe(b);

    const later = periodKeyFor(
      CampaignFrequency.EVERY_APP_OPEN,
      at(`2026-08-24T0${4 + 1}:00:00Z`),
    );
    expect(later).not.toBe(a);
  });

  it('has a floor measured in minutes', () => {
    expect(APP_OPEN_FLOOR_MINUTES).toBeGreaterThan(0);
  });
});

describe('impressionExpiryFor', () => {
  const now = at('2026-08-24T04:00:00Z');

  it('never expires a ONCE_EVER impression', () => {
    // The row IS the record that this account had its one showing. Sweeping it
    // would silently re-show a once-only campaign.
    expect(impressionExpiryFor(CampaignFrequency.ONCE_EVER, now)).toBeNull();
  });

  it.each([
    CampaignFrequency.DAILY,
    CampaignFrequency.WEEKLY,
    CampaignFrequency.EVERY_LOGIN,
    CampaignFrequency.EVERY_APP_OPEN,
  ])('gives %s a future expiry so the table does not grow forever', (freq) => {
    const expiry = impressionExpiryFor(freq, now);
    expect(expiry).not.toBeNull();
    expect(expiry!.getTime()).toBeGreaterThan(now.getTime());
  });
});
