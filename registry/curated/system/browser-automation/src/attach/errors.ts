/**
 * @fileoverview Structured errors + diagnostic redaction for the attach lane.
 *
 * Attach operations run inside the user's AUTHENTICATED browser, so raw error
 * text can carry session URLs, tokens, or account identifiers. Everything that
 * leaves the attach layer is (a) mapped to a stable machine-readable code and
 * (b) redacted of credential-class substrings before it can reach a report or
 * a model prompt (Codex spec review F13/F14).
 *
 * @module browser-automation/attach/errors
 */

/** Stable failure codes for every attach-lane operation. */
export type AttachErrorCode =
  | 'CDP_TIMEOUT'
  | 'CDP_UNAVAILABLE'
  | 'JS_DISABLED'
  | 'ACCESSIBILITY_DENIED'
  | 'PROFILE_MISMATCH'
  | 'TAB_CLOSED'
  | 'NAV_TIMEOUT'
  | 'POLICY_BLOCKED'
  | 'LEASE_DENIED'
  | 'STALE_PORT_FILE'
  | 'DAEMON_UNAVAILABLE' // no live daemon behind the IPC dir (stale heartbeat / never consumed)
  | 'DAEMON_RUNNING' // daemon pidfile lock held by a live pid; second start refused
  | 'NOT_CLAIMANT' // driving op from a client that does not hold the claim
  | 'UNSUPPORTED_OP' // backend lacks the optional capability (e.g. jxa evalInTab)
  | 'UNKNOWN';

/** Structured attach error surfaced to tools/callers. */
export interface StructuredAttachError {
  code: AttachErrorCode;
  /** Redacted, human-readable diagnostic. Never verbatim page/session text. */
  message: string;
}

/** Error subclass carrying a structured code through throw sites. */
export class AttachError extends Error {
  readonly code: AttachErrorCode;
  constructor(code: AttachErrorCode, message: string) {
    super(message);
    this.name = 'AttachError';
    this.code = code;
  }
}

const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/(token|secret|password|passwd|apikey|api_key|auth|bearer|session|cookie)(["']?\s*[:=]\s*["']?)[^\s"'&;]+/gi, '$1$2[redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
  [/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/[?&](code|state|id_token|access_token|refresh_token)=[^\s&"']+/gi, '?[redacted-param]'],
];

/**
 * Redact credential-class substrings from a diagnostic string.
 *
 * @param text Raw diagnostic text.
 * @returns The text with tokens/keys/secrets masked.
 */
export function redactDiagnostic(text: string): string {
  let out = String(text ?? '');
  for (const [re, rep] of CREDENTIAL_PATTERNS) out = out.replace(re, rep);
  return out;
}

const CODE_MATCHERS: Array<[RegExp, AttachErrorCode]> = [
  [/timeout.*connectovercdp|connectovercdp.*timeout|cdp.*timeout/i, 'CDP_TIMEOUT'],
  [/econnrefused|ws error|socket hang up|cdp.*unavailable/i, 'CDP_UNAVAILABLE'],
  [/javascript through applescript is turned off/i, 'JS_DISABLED'],
  [/not authorized to send apple events|accessibility/i, 'ACCESSIBILITY_DENIED'],
  [/profile.*mismatch|wrong profile/i, 'PROFILE_MISMATCH'],
  [/tab .* not found|window .* not found|target closed/i, 'TAB_CLOSED'],
  [/navigation.*timeout|nav.*timeout|net::err_timed_out/i, 'NAV_TIMEOUT'],
  [/policy|blocked|not allowed/i, 'POLICY_BLOCKED'],
  [/lease/i, 'LEASE_DENIED'],
  [/devtoolsactiveport.*malformed|stale.*port/i, 'STALE_PORT_FILE'],
];

/**
 * Map any thrown value to a {@link StructuredAttachError} with a redacted
 * message. An {@link AttachError} keeps its explicit code; everything else is
 * classified by message pattern, defaulting to `UNKNOWN`.
 */
export function toStructuredError(err: unknown): StructuredAttachError {
  if (err instanceof AttachError) {
    return { code: err.code, message: redactDiagnostic(err.message) };
  }
  const msg = err instanceof Error ? err.message : String(err);
  for (const [re, code] of CODE_MATCHERS) {
    if (re.test(msg)) return { code, message: redactDiagnostic(msg) };
  }
  return { code: 'UNKNOWN', message: redactDiagnostic(msg) };
}
