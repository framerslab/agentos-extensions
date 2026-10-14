/** Host-verified permission; this module does not establish provider authorization. */
export interface SourceCachePermission {
  readonly evidenceId: string;
  readonly retentionMs: number;
}

/** Cache metadata only; no request URL, token or response content enters the policy. */
export interface SourceCacheHeaders {
  readonly cacheControl: string | null;
  readonly date: string | null;
  readonly age: string | null;
  readonly expires: string | null;
}

/** Clock and retention bounds for one obtained source response. */
export interface SourceCacheInput {
  readonly permission: SourceCachePermission | null;
  readonly maximumCacheMs: number;
  readonly readStartedAt: number;
  readonly receivedAt: number;
  readonly windowExpiresAt: number;
  readonly headers: SourceCacheHeaders;
}

/** Fixed reasons safe to aggregate without content-bearing provider messages. */
export type SourceCacheSkipReason =
  | 'not_permitted' | 'no_store' | 'revalidation_required'
  | 'invalid_cache_header' | 'invalid_bounds' | 'expired';

/** A finite allowed lifetime, or an explicit refusal to persist any source content. */
export type SourceCacheDecision =
  | { readonly kind: 'cache'; readonly expiresAt: number; readonly evidenceId: string }
  | { readonly kind: 'skip'; readonly reason: SourceCacheSkipReason };

const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const positive = (value: number): boolean => integer(value) && value > 0;
const skip = (reason: SourceCacheSkipReason): SourceCacheDecision => ({ kind: 'skip', reason });

/** Whole seconds written in digits only, as safe-integer milliseconds; anything else is null. */
function milliseconds(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const converted = Number(value) * 1_000;
  return integer(converted) ? converted : null;
}

/** An HTTP date accepted only in the exact form `toUTCString` writes, so a loose parse cannot invent a time. */
function date(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return integer(parsed) && new Date(parsed).toUTCString() === value ? parsed : null;
}

/** Cache-Control directives by lower-case name; a malformed or repeated directive answers null. */
function directives(value: string | null): Map<string, string | null> | null {
  const found = new Map<string, string | null>();
  if (value === null || value.trim() === '') return found;
  for (const part of value.split(',')) {
    const match = /^([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|([^\s",]+)))?$/i.exec(part.trim());
    const name = match?.[1]?.toLowerCase();
    if (!match || !name || found.has(name)) return null;
    found.set(name, match[2] ?? match[3] ?? null);
  }
  return found;
}

/**
 * Applies explicit permission and conservative provider/cache/window limits.
 * Returned expiry is never extended by a history checkpoint or by calling this
 * function again with the old response. A new read needs its own permission check.
 */
export function decideSourceCache(input: SourceCacheInput): SourceCacheDecision {
  const permission = input.permission;
  if (!permission || typeof permission.evidenceId !== 'string'
    || permission.evidenceId.trim().length === 0 || !positive(permission.retentionMs)) {
    return skip('not_permitted');
  }
  if (!positive(input.maximumCacheMs) || !integer(input.readStartedAt)
    || !integer(input.receivedAt) || !integer(input.windowExpiresAt)
    || input.receivedAt < input.readStartedAt) return skip('invalid_bounds');

  const policyEnd = input.readStartedAt + Math.min(permission.retentionMs, input.maximumCacheMs);
  if (!integer(policyEnd)) return skip('invalid_bounds');
  const rules = directives(input.headers.cacheControl);
  if (rules === null) return skip('invalid_cache_header');
  if (rules.has('no-store')) return skip('no_store');
  if (rules.has('no-cache')) return skip('revalidation_required');

  const age = input.headers.age === null ? 0 : milliseconds(input.headers.age.trim());
  const responseDate = date(input.headers.date);
  const responseExpires = date(input.headers.expires);
  if (age === null || (input.headers.date !== null && responseDate === null)
    || (input.headers.expires !== null && responseExpires === null)) {
    return skip('invalid_cache_header');
  }
  const elapsed = input.receivedAt - input.readStartedAt;
  const apparentAge = responseDate === null ? 0 : Math.max(0, input.receivedAt - responseDate);
  const correctedAge = Math.max(apparentAge, age + elapsed);
  if (!integer(correctedAge)) return skip('invalid_cache_header');
  let expiresAt = Math.min(policyEnd - age, input.windowExpiresAt);

  for (const name of ['max-age', 's-maxage']) {
    if (!rules.has(name)) continue;
    const value = rules.get(name);
    if (value === null || value === undefined) return skip('invalid_cache_header');
    const freshFor = milliseconds(value);
    if (freshFor === null) return skip('invalid_cache_header');
    const freshUntil = input.receivedAt + freshFor - correctedAge;
    if (!Number.isSafeInteger(freshUntil)) return skip('invalid_cache_header');
    expiresAt = Math.min(expiresAt, freshUntil);
  }
  if (responseExpires !== null) {
    const freshFor = responseExpires - (responseDate ?? input.readStartedAt);
    const freshUntil = input.receivedAt + freshFor - correctedAge;
    if (!Number.isSafeInteger(freshUntil)) return skip('invalid_cache_header');
    expiresAt = Math.min(expiresAt, freshUntil, responseExpires);
  }
  if (!Number.isSafeInteger(expiresAt)) return skip('invalid_bounds');
  if (expiresAt <= input.receivedAt) return skip('expired');
  return { kind: 'cache', expiresAt, evidenceId: permission.evidenceId };
}
