import { describe, expect, it } from 'vitest';
import {
  decideSourceCache,
  type SourceCacheInput,
  type SourceCacheHeaders,
} from '../src/cachePolicy.js';

const start = 1_700_000_000_000;
const hour = 3_600_000;
const headers = (patch: Partial<SourceCacheHeaders> = {}): SourceCacheHeaders => ({
  cacheControl: null, date: null, age: null, expires: null, ...patch,
});
const input = (patch: Partial<SourceCacheInput> = {}): SourceCacheInput => ({
  permission: { evidenceId: 'approved-policy-a', retentionMs: 48 * hour },
  maximumCacheMs: 24 * hour,
  readStartedAt: start,
  receivedAt: start + 1_000,
  windowExpiresAt: start + 7 * 24 * hour,
  headers: headers(),
  ...patch,
});

function expiry(value: SourceCacheInput): number {
  const decision = decideSourceCache(value);
  expect(decision.kind).toBe('cache');
  if (decision.kind !== 'cache') throw new Error('fixture_expected_cache');
  expect(decision.evidenceId).toBe('approved-policy-a');
  return decision.expiresAt;
}

describe('source cache policy', () => {
  it('requires evidence even when a response promises a long freshness lifetime', () => {
    expect(decideSourceCache(input({
      permission: null, headers: headers({ cacheControl: 'max-age=86400' }),
    }))).toEqual({ kind: 'skip', reason: 'not_permitted' });
    expect(decideSourceCache(input({ permission: { evidenceId: '', retentionMs: hour } })))
      .toEqual({ kind: 'skip', reason: 'not_permitted' });
    expect(decideSourceCache(input({ permission: { evidenceId: 'approved-policy-a', retentionMs: 0 } })))
      .toEqual({ kind: 'skip', reason: 'not_permitted' });
  });

  it('uses the earliest permission, host maximum and per-message window', () => {
    expect(expiry(input())).toBe(start + 24 * hour);
    expect(expiry(input({ permission: { evidenceId: 'approved-policy-a', retentionMs: hour } })))
      .toBe(start + hour);
    expect(expiry(input({ windowExpiresAt: start + 3_000 }))).toBe(start + 3_000);
  });

  it.each(['no-store', 'private, no-store', 'MAX-AGE=300, NO-STORE'])(
    'refuses %s without creating a stored lifetime',
    (cacheControl) => {
      expect(decideSourceCache(input({ headers: headers({ cacheControl }) })))
        .toEqual({ kind: 'skip', reason: 'no_store' });
    },
  );

  it.each(['no-cache', 'private, no-cache="set-cookie"'])(
    'requires revalidation instead of persisting under %s',
    (cacheControl) => {
      expect(decideSourceCache(input({ headers: headers({ cacheControl }) })))
        .toEqual({ kind: 'skip', reason: 'revalidation_required' });
    },
  );

  it('subtracts Age and network time rather than refreshing an old cached response', () => {
    expect(expiry(input({ headers: headers({ cacheControl: 'private, max-age="60"', age: '10' }) })))
      .toBe(start + 50_000);
  });

  it('uses apparent age when the server Date is older than the Age header', () => {
    expect(expiry(input({
      headers: headers({
        cacheControl: 'max-age=60', age: '2', date: new Date(start - 20_000).toUTCString(),
      }),
    }))).toBe(start + 40_000);
  });

  it('takes the stricter shared freshness and never extends with Expires', () => {
    expect(expiry(input({ headers: headers({ cacheControl: 'max-age=600, s-maxage=30' }) })))
      .toBe(start + 30_000);
    expect(expiry(input({
      headers: headers({
        cacheControl: 'max-age=600', date: new Date(start).toUTCString(),
        expires: new Date(start + 20_000).toUTCString(),
      }),
    }))).toBe(start + 20_000);
  });

  it('uses absolute Expires conservatively if Date is absent', () => {
    expect(expiry(input({ headers: headers({ expires: new Date(start + 30_000).toUTCString() }) })))
      .toBe(start + 30_000);
  });

  it('refuses a lifetime already exhausted when the response arrives', () => {
    for (const value of [
      input({ headers: headers({ cacheControl: 'max-age=0' }) }),
      input({ headers: headers({ cacheControl: 'max-age=1', age: '1' }) }),
      input({ windowExpiresAt: start + 1_000 }),
      input({ headers: headers({ expires: new Date(start - 1_000).toUTCString() }) }),
    ]) {
      expect(decideSourceCache(value)).toEqual({ kind: 'skip', reason: 'expired' });
    }
  });

  it('fails closed on malformed or ambiguous provider metadata', () => {
    const bad: Partial<SourceCacheHeaders>[] = [
      { cacheControl: 'max-age=-1' },
      { cacheControl: 'max-age=word' },
      { cacheControl: 'max-age=1.5' },
      { cacheControl: 'max-age=30, max-age=60' },
      { cacheControl: 'max-age="broken' },
      { cacheControl: 'max-age=999999999999999999' },
      { age: '-1' }, { age: '0.5' }, { age: '' },
      { date: 'not-a-date' }, { date: '1' }, { expires: 'not-a-date' },
    ];
    for (const patch of bad) {
      expect(decideSourceCache(input({ headers: headers(patch) })))
        .toEqual({ kind: 'skip', reason: 'invalid_cache_header' });
    }
  });

  it('refuses invalid clocks, limits and overflow without leaking a value', () => {
    for (const patch of [
      { readStartedAt: -1 }, { receivedAt: start - 1 },
      { maximumCacheMs: 0 }, { maximumCacheMs: Number.POSITIVE_INFINITY },
      { windowExpiresAt: Number.NaN },
      { readStartedAt: Number.MAX_SAFE_INTEGER - 1, receivedAt: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(decideSourceCache(input(patch))).toEqual({ kind: 'skip', reason: 'invalid_bounds' });
    }
  });

  it('does not turn unknown harmless directives into permission or extra lifetime', () => {
    expect(expiry(input({ headers: headers({ cacheControl: 'private, immutable, extension="value"' }) })))
      .toBe(start + 24 * hour);
  });

  it('keeps commas and escaped quotes inside a quoted directive value', () => {
    const plain = input({ headers: headers({ cacheControl: 'private, max-age=60' }) });
    expect(expiry(plain)).toBe(start + 60_000);
    for (const cacheControl of ['private="a, b", max-age=60', 'private="a\\", b", max-age=60']) {
      expect(decideSourceCache(input({ headers: headers({ cacheControl }) })))
        .toEqual(decideSourceCache(plain));
    }
  });

  it('refuses a quoted directive value left open', () => {
    for (const cacheControl of ['private="a, max-age=60', 'private="a\\", max-age=60']) {
      expect(decideSourceCache(input({ headers: headers({ cacheControl }) })))
        .toEqual({ kind: 'skip', reason: 'invalid_cache_header' });
    }
  });
});
