/**
 * @module @framers/agentos-ext-wildweave-film/client
 *
 * The client over the studio's routes under `/api/v1/wildweave/studio/` on wilds.ai. Every call
 * carries the studio key in `Authorization` alone and an `x-client-request-id`, runs under a
 * deadline, and is retried by one rule: a network error, a 502, a 503 other than `not_open` and a
 * 504 are tried again twice, after 1 s and 4 s, for an idempotent call (every GET, a POST the
 * route answers idempotently: an edit carrying its `editId`, the export without an `ack`, a
 * decision, a submit carrying its `proposalId`); a 429 is tried again after its `Retry-After`, up
 * to three times, since the gate refuses it before the route does anything; a 401 or a 403 is
 * never retried. Every answer resolves, never throws: `{ ok: true, result }` or
 * `{ ok: false, error: { code, message, status, requestId, findings?, sceneId?, details? } }`.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from './log.js';
import { maskDeep, maskKeys } from './log.js';

/** A refusal: the route's code, or the client's own (`key_missing`, `network`, `timeout`). */
export interface StudioError {
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  findings?: unknown[];
  sceneId?: string;
  /** The rest of the route's answer: `stale_write`'s current edit times, `edit_refused`'s refused op, `edit_id_reused`'s seq. */
  details?: Record<string, unknown>;
}

/** What a call resolves to. */
export type StudioAnswer<T = unknown> = { ok: true; result: T; status: number; requestId: string } | { ok: false; error: StudioError };

/** Options for {@link WildweaveStudioClient}. */
export interface WildweaveStudioClientOptions {
  /** The studio's origin; `https://wilds.ai` by default. */
  baseUrl?: string;
  /** The per-account studio key; without it every call answers `key_missing`. */
  key?: string;
  /** One call's deadline; 30,000 ms by default. */
  timeoutMs?: number;
  /** The fetch to call; the global one by default. */
  fetch?: typeof fetch;
  log?: Logger;
  /** The request id sent as `x-client-request-id`; a UUID by default. */
  requestId?: () => string;
  /** How a retry waits; a timer by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-call options. */
export interface CallOptions {
  /** Whether a network error or a 502, 503 or 504 may be retried; true for a GET by default. */
  idempotent?: boolean;
  timeoutMs?: number;
}

/** The waits before the second and third try of an idempotent call. */
const RETRY_WAITS_MS = [1_000, 4_000] as const;
/** How many times a 429 is tried again. */
const RATE_RETRIES = 3;
/** The longest `Retry-After` the client waits out. */
const RATE_WAIT_MAX_MS = 60_000;
/** The export and the acknowledgement read or write every source. */
export const LONG_CALL_TIMEOUT_MS = 120_000;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a code means, for an answer whose body names none of its own. */
const CODE_MESSAGES: Record<string, string> = {
  key_missing: 'no studio key: set WILDWEAVE_STUDIO_KEY or the options.key of the pack',
  key_rejected: 'the studio key was refused: unknown, revoked or expired',
  forge_required: 'the account behind the key is not on the Forge tier, or the studio is not open to it',
  sign_in_required: 'no active account answers to the key',
  scope_required: "the studio key's scopes lack the one this route needs",
  rate_limited: "the studio key's rate was reached",
  not_found: 'the account holds no such film, document or proposal',
  not_open: 'the render worker is not open on the box; render with the local engine',
  stale_write: 'a document changed since it was read: read the film again and decide',
  edit_refused: 'the edit was refused: an op the module refuses, or a cut the engine refuses',
  edit_id_reused: 'the editId was used for another edit',
  film_unreadable: "the film's documents are gone or do not parse",
  record_reimport_required: 'the import record holds no sidecar: import the film again before editing it',
  body_too_large: 'the body is over the studio bound of 1 MiB',
  invalid_body: 'the route refused the body',
  already_decided: 'the proposal was decided already',
  source_app_needs_session: "a studio key cannot record a decision as said in the app: send source 'relayed'",
  seq_unknown: 'the edit log holds no such row',
  import_between: 'an import row lies between: a revert across it needs force',
  scene_unknown: 'the film has no such scene',
};

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The seconds a `Retry-After` names, as milliseconds; 5 s when it names none this reads. */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5_000;
  return Math.min(ms, RATE_WAIT_MAX_MS);
}

/** A path segment, encoded. */
const seg = (value: string): string => encodeURIComponent(value);

/** The client over the studio's routes. */
export class WildweaveStudioClient {
  private readonly base: string;
  private readonly secrets: string[];

  constructor(private readonly opts: WildweaveStudioClientOptions = {}) {
    this.base = `${(opts.baseUrl ?? 'https://wilds.ai').replace(/\/+$/, '')}/api/v1/wildweave/studio`;
    this.secrets = opts.key ? [opts.key] : [];
  }

  /** True when the client holds a key. */
  get hasKey(): boolean {
    return typeof this.opts.key === 'string' && this.opts.key.length > 0;
  }

  /**
   * One studio route: the key in `Authorization` alone, retried by the module's rule. Resolves with
   * the route's answer or its refusal; never throws on a route's answer.
   */
  async call<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, callOpts: CallOptions = {}): Promise<StudioAnswer<T>> {
    if (!this.hasKey) return { ok: false, error: { code: 'key_missing', message: CODE_MESSAGES.key_missing! } };
    const requestId = this.opts.requestId?.() ?? randomUUID();
    const url = `${this.base}${path}`;
    const idempotent = callOpts.idempotent ?? method === 'GET';
    const timeoutMs = callOpts.timeoutMs ?? this.opts.timeoutMs ?? 30_000;
    const doFetch = this.opts.fetch ?? fetch;
    const sleep = this.opts.sleep ?? sleepFor;
    let transientTries = 0;
    let rateTries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.key}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-client-request-id': requestId,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (idempotent && transientTries < RETRY_WAITS_MS.length) {
          const wait = RETRY_WAITS_MS[transientTries]!;
          transientTries += 1;
          this.opts.log?.info({ event: 'wildweave_film.retry', path, attempt: transientTries, afterMs: wait, cause: timedOut ? 'timeout' : 'network' }, 'retrying after a network error');
          await sleep(wait);
          continue;
        }
        const message = timedOut ? `no answer within ${timeoutMs} ms` : maskKeys(err instanceof Error ? err.message : String(err), this.secrets);
        this.opts.log?.info({ event: 'wildweave_film.refused', path, code: timedOut ? 'timeout' : 'network' }, 'the studio did not answer');
        return { ok: false, error: { code: timedOut ? 'timeout' : 'network', message, requestId } };
      }
      const text = await response.text().catch(() => '');
      const json = parseJson(text);
      const id = response.headers.get('x-request-id') ?? requestId;
      const status = response.status;
      const routeCode = isRec(json) && typeof json.error === 'string' ? json.error : undefined;

      if (status === 429 && rateTries < RATE_RETRIES) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        rateTries += 1;
        this.opts.log?.info({ event: 'wildweave_film.retry', path, attempt: rateTries, afterMs: wait, status }, 'retrying after the rate limit');
        await sleep(wait);
        continue;
      }
      const transient = status === 502 || status === 504 || (status === 503 && routeCode !== 'not_open');
      if (transient && idempotent && transientTries < RETRY_WAITS_MS.length) {
        const wait = RETRY_WAITS_MS[transientTries]!;
        transientTries += 1;
        this.opts.log?.info({ event: 'wildweave_film.retry', path, attempt: transientTries, afterMs: wait, status }, 'retrying after a gateway answer');
        await sleep(wait);
        continue;
      }
      // A 2xx is the route's answer, `{ ok: false }` included (the validate's answer when a finding is an error), unless it names a refusal code.
      if (status >= 200 && status < 300 && !(isRec(json) && json.ok === false && routeCode !== undefined)) {
        return { ok: true, result: (json === undefined ? { text: maskKeys(text, this.secrets) } : json) as T, status, requestId: id };
      }
      const error = this.refusal(status, json, text, id);
      this.opts.log?.info({ event: 'wildweave_film.refused', path, status, code: error.code, requestId: id }, 'the studio refused the call');
      return { ok: false, error };
    }
  }

  /** The refusal a non-2xx answer (or a 2xx naming one) carries. */
  private refusal(status: number, json: unknown, text: string, requestId: string): StudioError {
    const body = isRec(json) ? json : {};
    const code = typeof body.error === 'string' ? body.error : status === 401 ? 'key_rejected' : status === 403 ? 'forge_required' : `http_${status}`;
    const refused = isRec(body.refused) ? body.refused : undefined;
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof refused?.message === 'string'
          ? refused.message
          : (CODE_MESSAGES[code] ?? (json === undefined && text.trim() !== '' ? text.slice(0, 300) : `the studio answered HTTP ${status}`));
    const { error: _code, message: _message, findings, sceneId, ...rest } = body;
    const error: StudioError = { code, message: maskKeys(message, this.secrets), status, requestId };
    if (Array.isArray(findings)) error.findings = findings;
    if (typeof sceneId === 'string') error.sceneId = sceneId;
    if (Object.keys(rest).length > 0) error.details = maskDeep(rest, this.secrets) as Record<string, unknown>;
    return error;
  }

  // ── One method per route ─────────────────────────────────────────────────────────────────────

  /** GET /films: the account's films. */
  listFilms() {
    return this.call('GET', '/films');
  }
  /** GET /films/:filmId/documents: the documents the import binds. */
  documents(filmId: string) {
    return this.call('GET', `/films/${seg(filmId)}/documents`);
  }
  /** GET /documents/:documentId: one bound document with its content. */
  document(documentId: string) {
    return this.call('GET', `/documents/${seg(documentId)}`);
  }
  /** GET /films/:filmId/timeline: the timeline, the sidecar, their hashes, the edit times and the readiness. */
  timeline(filmId: string) {
    return this.call('GET', `/films/${seg(filmId)}/timeline`);
  }
  /** GET /films/:filmId/scenes/:sceneId: one scene, its sidecar entry, readiness and findings. */
  scene(filmId: string, sceneId: string) {
    return this.call('GET', `/films/${seg(filmId)}/scenes/${seg(sceneId)}`);
  }
  /** POST /films/:filmId/validate: the in-app validate; reads only, so retried. */
  validate(filmId: string) {
    return this.call('POST', `/films/${seg(filmId)}/validate`, {}, { idempotent: true });
  }
  /** GET /films/:filmId/inspect: the engine's inspect over the cut the documents give. */
  inspect(filmId: string) {
    return this.call('GET', `/films/${seg(filmId)}/inspect`);
  }
  /** POST /films/:filmId/edits: the route answers a repeated editId with the stored answer, so retried. */
  edit(filmId: string, body: { editId: string; ifUpdatedAtMs: Record<string, number>; ops: unknown[]; dryRun?: boolean }) {
    return this.call('POST', `/films/${seg(filmId)}/edits`, body, { idempotent: true });
  }
  /** GET /films/:filmId/edits?since=: the edit log after a seq. */
  edits(filmId: string, since?: number) {
    return this.call('GET', `/films/${seg(filmId)}/edits${since === undefined ? '' : `?since=${since}`}`);
  }
  /** POST /films/:filmId/revert: a write with no id of its own, never retried. */
  revert(filmId: string, body: { toSeq: number; ifUpdatedAtMs: Record<string, number>; force?: boolean }) {
    return this.call('POST', `/films/${seg(filmId)}/revert`, body, { idempotent: false });
  }
  /** POST /films/:filmId/export without an ack: the sources as the account holds them; reads only, so retried. */
  exportSources(filmId: string) {
    return this.call('POST', `/films/${seg(filmId)}/export`, {}, { idempotent: true, timeoutMs: LONG_CALL_TIMEOUT_MS });
  }
  /** POST /films/:filmId/export with an ack: a write with no id, never retried (a second ack of the same hashes is recorded and rebinds nothing). */
  acknowledge(filmId: string, body: { ack: Record<string, string>; ifUpdatedAtMs: Record<string, number> }) {
    return this.call('POST', `/films/${seg(filmId)}/export`, body, { idempotent: false, timeoutMs: LONG_CALL_TIMEOUT_MS });
  }
  /** POST /films/:filmId/jobs: a render job on the box (503 not_open until the worker ships). */
  startJob(filmId: string, body: Record<string, unknown>) {
    return this.call('POST', `/films/${seg(filmId)}/jobs`, body, { idempotent: false });
  }
  /** GET /films/:filmId/jobs/:jobId: one render job (503 not_open until the worker ships). */
  job(filmId: string, jobId: string) {
    return this.call('GET', `/films/${seg(filmId)}/jobs/${seg(jobId)}`);
  }
  /** GET /films/:filmId/preview: the film's page, readiness and staged files. */
  preview(filmId: string) {
    return this.call('GET', `/films/${seg(filmId)}/preview`);
  }
  /** GET /films/:filmId/proposals?status=: the yes-list, oldest first. */
  proposals(filmId: string, status?: string) {
    return this.call('GET', `/films/${seg(filmId)}/proposals${status === undefined ? '' : `?status=${seg(status)}`}`);
  }
  /** POST /films/:filmId/proposals: retried only when it carries its proposalId, which makes it idempotent on the route. */
  submitProposal(filmId: string, body: Record<string, unknown>) {
    return this.call('POST', `/films/${seg(filmId)}/proposals`, body, { idempotent: typeof body.proposalId === 'string' });
  }
  /** POST /films/:filmId/proposals/:proposalId/decision: the route answers the same decision sent again with the one that stands, so retried. */
  decideProposal(filmId: string, proposalId: string, body: { verdict: string; words: string; source: string }) {
    return this.call('POST', `/films/${seg(filmId)}/proposals/${seg(proposalId)}/decision`, body, { idempotent: true });
  }
}
