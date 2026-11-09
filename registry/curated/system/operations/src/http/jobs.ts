/**
 * @fileoverview The jobs handlers of `./http`: the list and a job's page, the four full lists, and
 * pause, resume and a hand run, each a `(request, params) => Promise<Response>` over the host's
 * staff check and the scheduler of record. The reads ask for `ops.read` and the commands for
 * `ops.manage`; every answer is JSON with `cache-control: no-store`. A refusal answers
 * `{ error: <word>, status }` with its status, or the host's own `Response` when it gives `refusal`.
 *
 * `zod`, which checks a pause's body, is an optional peer: it is loaded at the first pause, so the
 * entry imports without it, and a host without it answers a pause with a 500 naming the peer.
 */
import type { OpsHandler, OpsHandlersOptions, OpsJobCounts, OpsJobsHandlers, OpsJobsRefusal, OpsPermission, OpsRefusal, OpsStaff } from '../contract.js';

/** A job's name as the scheduler of record takes it: a lower-case letter, then at most 63 lower-case letters, digits or underscores. */
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The longest pause note, the scheduler's own bound. */
const NOTE_MAX = 200;
/** The state words the list's filter takes: the scheduler's states and `attention` (failed, stalled or missed). */
const STATES: ReadonlySet<string> = new Set(['ok', 'running', 'failed', 'missed', 'stalled', 'paused', 'no_run', 'attention']);
/** What a job's page shows of each list. */
const SHOWN = { runs: 20, alerts: 10, changes: 10 } as const;
/** What the full lists answer: the runs the scheduler keeps a job, and the alerts and changes the page offers. */
const KEPT = { runs: 100, alerts: 50, changes: 50 } as const;
/** The most bytes a pause's body may hold: a 200-character note fits written every character as an escape, and a body past it is refused unread. */
const BODY_MAX = 4_096;
/** The most list pages the counts read: 200 jobs a page, so 20,000 jobs. */
const COUNT_PAGES_MAX = 100;

/** A JSON answer that is never cached. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** `response` with `cache-control: no-store`, added when it has none; a response whose headers cannot change is copied. */
function noStore(response: Response): Response {
  if (response.headers.has('cache-control')) return response;
  try {
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

/** The module `zod` once loaded, or null until the first pause. */
let zod: typeof import('zod') | null = null;

/** What a pause's body reads as: its note (absent when none or blank), a body outside the rule, or a host without `zod`. */
type NoteRead = { readonly note: string | undefined } | 'bad_request' | 'no_zod';

/** The body's text, read up to `BODY_MAX` bytes: null past it (the rest left unread) or when the body cannot be read. */
async function textOf(request: Request): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_MAX) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `zod`, loaded at the first call and kept; null when the host has not installed it. */
async function loadZod(): Promise<typeof import('zod') | null> {
  try {
    zod ??= await import('zod');
    return zod;
  } catch {
    return null;
  }
}

/** Reads a pause's body: none, an empty one, or `{ note? }` with a note of at most 200 characters and no other key. */
async function noteOf(request: Request): Promise<NoteRead> {
  const loaded = await loadZod();
  if (loaded === null) return 'no_zod';
  const text = await textOf(request);
  if (text === null) return 'bad_request';
  let body: unknown = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      return 'bad_request';
    }
  }
  const Body = loaded.z.object({ note: loaded.z.string().max(NOTE_MAX).optional() }).strict();
  const parsed = Body.safeParse(body);
  if (!parsed.success) return 'bad_request';
  const note = parsed.data.note;
  return { note: note === undefined || note.trim() === '' ? undefined : note };
}

/** Whether `answer` is a refusal: an object carrying a string `refused` and a numeric `status`. */
function isRefusal(answer: unknown): answer is OpsJobsRefusal {
  return typeof answer === 'object' && answer !== null && typeof (answer as { refused?: unknown }).refused === 'string' && typeof (answer as { status?: unknown }).status === 'number';
}

/** Checks the options' hooks once, when the handlers are built. */
function check(options: OpsHandlersOptions): void {
  if (typeof options?.auth?.staff !== 'function') throw new TypeError('createHandlers: auth.staff is the host\'s staff check');
  if (typeof options.operations?.alerts?.list !== 'function') throw new TypeError('createHandlers: operations is the value createOperations answered');
  const scheduler = options.scheduler as unknown as Record<string, unknown> | undefined;
  for (const member of ['list', 'get', 'runs', 'missed', 'pause', 'resume', 'runNow']) {
    if (typeof scheduler?.[member] !== 'function') throw new TypeError(`createHandlers: scheduler.${member} is missing; give the scheduler of record`);
  }
  if (typeof options.changes !== 'function') throw new TypeError('createHandlers: changes(name, limit) is the product\'s staff record for a job');
  if (options.refusal !== undefined && typeof options.refusal !== 'function') throw new TypeError('createHandlers: refusal is a function answering a Response');
}

/** Builds the nine jobs handlers over `options`. */
export function createJobsHandlers(options: OpsHandlersOptions): OpsJobsHandlers {
  check(options);
  const { auth, operations, scheduler } = options;

  /** A refusal answered by the host's `refusal`, else as `{ error, status }` (with `retryAt` and `retryAfter` when given). */
  const refused = (refusal: OpsJobsRefusal): Response => {
    const given: OpsJobsRefusal = {
      refused: refusal.refused,
      status: refusal.status,
      ...(typeof refusal.retryAt === 'number' ? { retryAt: refusal.retryAt } : {}),
      ...(typeof refusal.retryAfter === 'number' ? { retryAfter: refusal.retryAfter } : {}),
    };
    if (options.refusal !== undefined) return noStore(options.refusal(given));
    const { refused: error, ...rest } = given;
    return json({ error, ...rest }, given.status);
  };
  const notFound = (): Response => refused({ refused: 'not_found', status: 404 });
  const badRequest = (): Response => refused({ refused: 'bad_request', status: 400 });

  /** The staff member the host's check answers for `permission`, or the refusal's answer. */
  const staffFor = async (request: Request, permission: OpsPermission): Promise<OpsStaff | Response> => {
    const staff: OpsStaff | OpsRefusal = await auth.staff(request, permission);
    if ('refused' in staff) return refused(staff);
    return staff;
  };

  /** The route's job name under the scheduler's rule, or null. */
  const nameOf = (params: { readonly name?: string } | undefined): string | null => {
    const name = params?.name;
    return typeof name === 'string' && NAME.test(name) ? name : null;
  };

  /** The counts over every job on the instance: `first` is the unfiltered first page when the request read it already. */
  const countAll = async (first: { readonly jobs: readonly unknown[]; readonly cursor: string | null } | null): Promise<OpsJobCounts> => {
    const counts = { total: 0, failed: 0, stalled: 0, missed24h: 0, paused: 0, attention: 0 };
    let page = first ?? (await scheduler.list({}));
    const seen = new Set<string>();
    for (let pages = 1; ; pages += 1) {
      for (const job of page.jobs) {
        const { state, missed24h } = (job ?? {}) as { readonly state?: unknown; readonly missed24h?: unknown };
        counts.total += 1;
        if (state === 'failed') counts.failed += 1;
        if (state === 'stalled') counts.stalled += 1;
        if (state === 'paused') counts.paused += 1;
        if (state === 'failed' || state === 'stalled' || state === 'missed') counts.attention += 1;
        if (typeof missed24h === 'number' && Number.isFinite(missed24h) && missed24h > 0) counts.missed24h += missed24h;
      }
      const next = page.cursor;
      // A cursor seen before, or past the page bound, ends the count, so a scheduler whose pages never end cannot hold the answer.
      if (next === null || seen.has(next) || pages >= COUNT_PAGES_MAX) return counts;
      seen.add(next);
      page = await scheduler.list({ cursor: next });
    }
  };

  /** A read of one job's list: the staff check, the name, the job's existence, then `read`. */
  const listOf =
    (read: (name: string) => Promise<Record<string, unknown>>): OpsHandler =>
    async (request, params) => {
      const staff = await staffFor(request, 'ops.read');
      if (staff instanceof Response) return staff;
      const name = nameOf(params);
      if (name === null) return notFound();
      if ((await scheduler.get(name)) === null) return notFound();
      return json(await read(name));
    };

  /** A command's answer: a refusal with its word and status, else the job's view; a `RangeError` from the scheduler is `bad_request`. */
  const commandAnswer = async (run: () => Promise<unknown>): Promise<Response> => {
    let answer: unknown;
    try {
      answer = await run();
    } catch (error) {
      if (error instanceof RangeError) return badRequest();
      throw error;
    }
    if (isRefusal(answer)) return refused(answer);
    if (answer === null || answer === undefined) return notFound();
    return json(answer);
  };

  return {
    async list(request) {
      const staff = await staffFor(request, 'ops.read');
      if (staff instanceof Response) return staff;
      const query = new URL(request.url, 'http://localhost').searchParams;
      const filter: { state?: string; process?: string; cursor?: string } = {};
      const state = query.get('state');
      const processWord = query.get('process');
      const cursor = query.get('cursor');
      if (state !== null && state !== '') {
        if (!STATES.has(state)) return badRequest();
        filter.state = state;
      }
      if (processWord !== null && processWord !== '') filter.process = processWord;
      if (cursor !== null && cursor !== '') filter.cursor = cursor;
      const page = await scheduler.list(filter);
      const counts = await countAll(Object.keys(filter).length === 0 ? page : null);
      return json({ jobs: page.jobs, cursor: page.cursor, counts });
    },

    async get(request, params) {
      const staff = await staffFor(request, 'ops.read');
      if (staff instanceof Response) return staff;
      const name = nameOf(params);
      if (name === null) return notFound();
      const job = await scheduler.get(name);
      if (job === null) return notFound();
      // One read after another, so a host on one connection never holds two at once.
      const runs = await scheduler.runs(name, { limit: SHOWN.runs });
      const missed = await scheduler.missed(name);
      const alerts = await operations.alerts.list({ source: name }, { limit: SHOWN.alerts });
      const changes = await options.changes(name, SHOWN.changes);
      return json({ job, runs, missed, alerts, changes, kept: { ...KEPT } });
    },

    runs: listOf(async (name) => ({ runs: await scheduler.runs(name, { limit: KEPT.runs }) })),
    missed: listOf(async (name) => ({ missed: await scheduler.missed(name) })),
    alerts: listOf(async (name) => ({ alerts: await operations.alerts.list({ source: name }, { limit: KEPT.alerts }) })),
    changes: listOf(async (name) => ({ changes: await options.changes(name, KEPT.changes) })),

    async pause(request, params) {
      const staff = await staffFor(request, 'ops.manage');
      if (staff instanceof Response) return staff;
      const name = nameOf(params);
      if (name === null) return notFound();
      const read = await noteOf(request);
      if (read === 'no_zod') return json({ error: 'missing_peer', status: 500, peer: 'zod' }, 500);
      if (read === 'bad_request') return badRequest();
      return commandAnswer(() => scheduler.pause(name, { accountId: staff.accountId }, read.note));
    },

    async resume(request, params) {
      const staff = await staffFor(request, 'ops.manage');
      if (staff instanceof Response) return staff;
      const name = nameOf(params);
      if (name === null) return notFound();
      return commandAnswer(() => scheduler.resume(name, { accountId: staff.accountId }));
    },

    async run(request, params) {
      const staff = await staffFor(request, 'ops.manage');
      if (staff instanceof Response) return staff;
      const name = nameOf(params);
      if (name === null) return notFound();
      // The scheduler answers `{ queued: true }`; the page reads "Running (asked by ...)" from the job read after it, so that view is the answer.
      return commandAnswer(async () => {
        const queued = await scheduler.runNow(name, { accountId: staff.accountId });
        return 'refused' in queued ? queued : scheduler.get(name);
      });
    },
  };
}
