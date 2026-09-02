import { performance } from 'node:perf_hooks';
import { escapeRegex, exactMatchInsensitive } from './escape-regex.util';

/**
 * API-002/003 — regression tests for the three unescaped RegExp constructions
 * in branches.service.ts and washer-service-templates.service.ts.
 *
 * Each case here describes a real branch/template name a user can type. All of
 * them fail against `new RegExp('^' + name + '$', 'i')`.
 */

describe('operator names are matched literally (API-002)', () => {
  it('EC: ".*" does not match an unrelated existing name', () => {
    // The duplicate-name check ran this against every stored branch. Unescaped,
    // `^.*$` matches all of them, so creating a branch called ".*" reported
    // whichever branch it hit first as already taken — and every later name
    // collided with it too.
    expect(exactMatchInsensitive('.*').test('Makati Main')).toBe(false);
  });

  it('HP: ".*" still matches itself, so real duplicates are still caught', () => {
    expect(exactMatchInsensitive('.*').test('.*')).toBe(true);
  });

  it('EC: a character class does not match its members', () => {
    expect(exactMatchInsensitive('[a-z]+').test('makati')).toBe(false);
    expect(exactMatchInsensitive('[a-z]+').test('[a-z]+')).toBe(true);
  });

  it('EC: alternation does not match either side', () => {
    expect(exactMatchInsensitive('Makati|Taguig').test('Makati')).toBe(false);
    expect(exactMatchInsensitive('Makati|Taguig').test('Makati|Taguig')).toBe(
      true,
    );
  });

  it('EC: a name with a bare "(" does not throw', () => {
    // Unescaped this is an unterminated group — `new RegExp` throws
    // SyntaxError, which surfaced as a 500 rather than a validation error.
    expect(() => exactMatchInsensitive('Ayala (Annex')).not.toThrow();
    expect(exactMatchInsensitive('Ayala (Annex').test('Ayala (Annex')).toBe(
      true,
    );
  });

  it('HP: ordinary names are unaffected', () => {
    const rx = exactMatchInsensitive('Makati Main');
    expect(rx.test('Makati Main')).toBe(true);
    expect(rx.test('MAKATI MAIN')).toBe(true); // case-insensitive, as before
    expect(rx.test('Makati Main 2')).toBe(false); // still anchored
    expect(rx.test('Taguig')).toBe(false);
  });

  it('HP: every regex metacharacter round-trips as a literal', () => {
    const nasty = '.*+?^${}()|[]\\';
    expect(exactMatchInsensitive(nasty).test(nasty)).toBe(true);
  });
});

describe('catastrophic backtracking (API-003)', () => {
  it('EC: a nested-quantifier payload cannot pin the CPU', () => {
    // Unescaped, `^(a+)+$` against a long non-matching string explores
    // exponentially many partitions — one request, one core, effectively
    // forever. Escaped, it is a 6-character literal and fails immediately.
    const payload = '(a+)+$';
    const victim = `${'a'.repeat(40)}!`;

    const rx = exactMatchInsensitive(payload);
    const started = performance.now();
    const matched = rx.test(victim);
    const elapsedMs = performance.now() - started;

    expect(matched).toBe(false);
    expect(elapsedMs).toBeLessThan(50);
  });

  it('EC: a second classic payload shape is equally inert', () => {
    const rx = exactMatchInsensitive('(a|aa)+');
    const started = performance.now();
    expect(rx.test(`${'a'.repeat(40)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('escapeRegex', () => {
  it('HP: escapes exactly the characters that carry meaning', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b');
    expect(escapeRegex('a+b')).toBe('a\\+b');
  });

  it('HP: leaves ordinary text untouched', () => {
    expect(escapeRegex('Makati Main 2')).toBe('Makati Main 2');
  });

  it('EC: an empty string is safe', () => {
    expect(escapeRegex('')).toBe('');
    expect(exactMatchInsensitive('').test('')).toBe(true);
  });
});
