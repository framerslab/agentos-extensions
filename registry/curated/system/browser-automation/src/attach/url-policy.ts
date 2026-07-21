/**
 * @fileoverview Navigation URL policy for the attach lane.
 *
 * An attached session drives the user's REAL logged-in browser, so navigation
 * is deny-by-default: only `https:` targets (plus `about:blank` for parking)
 * are ever allowed, and even then never credential-bearing URLs or private /
 * loopback hosts. `file:`, `javascript:`, `data:`, `devtools:`, `chrome:` and
 * every other scheme are rejected outright. Redirect targets MUST be re-checked
 * with the same policy (Codex spec review F12).
 *
 * @module browser-automation/attach/url-policy
 */

/** Options for {@link isNavigationAllowed}. */
export interface UrlPolicyOptions {
  /**
   * Optional host allowlist. When present, an https URL must match one of
   * these hosts (exact, or a subdomain of an entry) in addition to the base
   * policy. `about:blank` is always allowed regardless.
   */
  allowHosts?: string[];
}

/** Result of a policy check. */
export interface UrlPolicyResult {
  allowed: boolean;
  /** Stable machine-readable reason when rejected. */
  reason?:
    | 'SCHEME_BLOCKED'
    | 'CREDENTIALS_IN_URL'
    | 'PRIVATE_HOST'
    | 'HOST_NOT_ALLOWLISTED'
    | 'MALFORMED_URL';
}

const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|.*\.local)$/i;

/**
 * Check whether navigating the attached tab to `url` is permitted.
 *
 * @param url  Target URL (absolute).
 * @param opts Optional host allowlist.
 */
export function isNavigationAllowed(url: string, opts: UrlPolicyOptions = {}): UrlPolicyResult {
  if (url === 'about:blank') return { allowed: true };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'MALFORMED_URL' };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, reason: 'SCHEME_BLOCKED' };
  if (parsed.username || parsed.password) return { allowed: false, reason: 'CREDENTIALS_IN_URL' };
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return { allowed: false, reason: 'PRIVATE_HOST' };
  if (opts.allowHosts && opts.allowHosts.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const ok = opts.allowHosts.some((h) => {
      const entry = h.toLowerCase();
      return host === entry || host.endsWith(`.${entry}`);
    });
    if (!ok) return { allowed: false, reason: 'HOST_NOT_ALLOWLISTED' };
  }
  return { allowed: true };
}

/**
 * Re-validate a redirect: the landing URL must clear the SAME policy as the
 * original navigation. A redirect to a blocked target is a policy violation
 * even though the original request was allowed.
 */
export function revalidateRedirect(landedUrl: string, opts: UrlPolicyOptions = {}): UrlPolicyResult {
  return isNavigationAllowed(landedUrl, opts);
}
