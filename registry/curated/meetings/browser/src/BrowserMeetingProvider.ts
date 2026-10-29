import { DispatchRefusedError, NoCapacityError, workerTokenMatches, type DispatchInput, type DispatchResult, type IMeetingBotProvider, type MeetingBotCapabilities, type MeetingPlatform, type MeetingRunRecord, type ProviderCommand, type ProviderEventContext, type ProviderParseResult, type ProviderUsage, type ProviderVerificationResult } from '@framers/agentos/io/channels/meetings';
import { ReportPost, RunStatus, reportEventId, type StartRunRequest } from './protocol.js';

/** How the provider reaches a worker's scheduler. */
export interface BrowserMeetingProviderOptions {
  /** The scheduler's base url on the worker (`https://…`). */
  schedulerUrl: string;
  /** The client credential the scheduler accepts from the product. */
  schedulerToken: string;
  /** The worker's id, as the scheduler reports it. */
  workerId: string;
  /** The identity the bot publishes under in the run's room. Default `bot`. */
  botIdentity?: string;
  /** The `fetch` the provider calls the scheduler with. Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Platforms this worker serves. Default both. */
  platforms?: readonly MeetingPlatform[];
}

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#].*)?$/;
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.live.com']);

/** A join url's platform, by its host and path: no redirect is followed, no other host is accepted. */
export function classifyJoinUrl(url: string): { ok: true; platform: MeetingPlatform } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'not a url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, message: 'the link must be https' };
  if (parsed.username || parsed.password) return { ok: false, message: 'the link carries credentials' };
  if (parsed.hostname === 'meet.google.com') return MEET_URL.test(url) ? { ok: true, platform: 'google_meet' } : { ok: false, message: 'not a Google Meet join link' };
  if (TEAMS_HOSTS.has(parsed.hostname)) {
    const path = parsed.pathname;
    if (path.startsWith('/l/meetup-join/') || path.startsWith('/meet/')) return { ok: true, platform: 'microsoft_teams' };
    return { ok: false, message: 'not a Microsoft Teams join link' };
  }
  return { ok: false, message: 'not a Google Meet or Microsoft Teams link' };
}

/**
 * The browser-join meeting provider: it hands each run to a worker's scheduler
 * over HTTP and authenticates the scheduler's reports by the run's worker
 * token. It never drives a browser itself; the scheduler starts one container
 * per run.
 */
export class BrowserMeetingProvider implements IMeetingBotProvider {
  /** The name the manager registers the provider under. */
  readonly name = 'browser';
  /** The platforms this worker serves. */
  readonly platforms: readonly MeetingPlatform[];
  /** A participant that posts and reads the chat, publishes audio into a LiveKit room, and records nothing. */
  readonly capabilities: MeetingBotCapabilities = { joinsAsParticipant: true, postsChat: true, readsChat: true, audioPath: 'livekit_room', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'chat' };
  private readonly fetch: typeof fetch;

  /** @param options - The scheduler's url, its client credential and the worker's id. */
  constructor(private readonly options: BrowserMeetingProviderOptions) {
    this.platforms = options.platforms ?? ['google_meet', 'microsoft_teams'];
    this.fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** Classifies a join url ({@link classifyJoinUrl}) and refuses a platform this worker does not serve. */
  checkJoinUrl(url: string): { ok: true; platform: MeetingPlatform } | { ok: false; message: string } {
    const r = classifyJoinUrl(url);
    if (r.ok && !this.platforms.includes(r.platform)) return { ok: false, message: `${r.platform} is not served by this worker` };
    return r;
  }

  /** Accepts a report whose bearer token hashes to the run's dispatch record. */
  verifyEvent(ctx: ProviderEventContext, run: MeetingRunRecord | undefined): ProviderVerificationResult {
    const raw = ctx.headers.authorization ?? ctx.headers.Authorization;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value?.startsWith('Bearer ')) return { valid: false, error: 'no bearer token' };
    if (!run?.dispatch?.workerTokenHash) return { valid: false, error: 'the run has no dispatch record' };
    return workerTokenMatches(value.slice(7), run.dispatch.workerTokenHash) ? { valid: true } : { valid: false, error: 'token mismatch' };
  }

  /** Reads one forwarded report; its event id is `browser:<run>:<seq>:<event>`. Throws on a body that is not a report. */
  parseEvent(ctx: ProviderEventContext): ProviderParseResult {
    const text = typeof ctx.body === 'string' ? ctx.body : ctx.body.toString('utf8');
    const post = ReportPost.parse(JSON.parse(text));
    return { events: [{ eventId: reportEventId(post.runId, post.seq, post.event), runId: post.runId, type: post.event, at: post.at, data: post.data as ProviderParseResult['events'][number]['data'] }], rawData: post };
  }

  private async call(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    const res = await this.fetch(`${this.options.schedulerUrl}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${this.options.schedulerToken}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
    });
    return res;
  }

  /**
   * Starts a run. A 409's exact `error` word picks the refusal, and no response text reaches it: `no slot` (every slot
   * is leased) and `no identity` (every signed-in Google Meet identity is held by a live run, or the pool cannot be read)
   * throw `NoCapacityError`; `no signed-in identity` (no identity in the pool is signed in) and `paused` throw
   * `DispatchRefusedError('permission_denied', 'no_identity')` and `DispatchRefusedError('permission_denied', 'paused')`.
   * Any other 409 body throws a fixed error, which the manager treats as a fault of the moment.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const body: StartRunRequest = {
      runId: input.run.runId,
      platform: input.run.platform as StartRunRequest['platform'],
      meetingUrl: input.run.meetingUrl,
      botName: input.run.botName,
      notice: input.run.notice,
      stopPhrase: input.run.stopPhrase,
      limits: { waitingRoomMs: input.run.limits.waitingRoomMs, aloneMs: input.run.limits.aloneMs, totalMs: input.run.limits.totalMs },
      livekit: { url: input.room.url, token: input.room.publishToken, identity: this.options.botIdentity ?? 'bot' },
      workerToken: input.workerToken,
      reportUrl: input.reportUrl,
    };
    const res = await this.call('/runs', { method: 'POST', body });
    if (res.status === 409) {
      let refused: unknown;
      try { refused = await res.json(); } catch { refused = undefined; }
      if (typeof refused === 'object' && (refused === null) === false && 'error' in refused) {
        if (refused.error === 'no signed-in identity') throw new DispatchRefusedError('permission_denied', 'no_identity');
        if (refused.error === 'paused') throw new DispatchRefusedError('permission_denied', 'paused');
        // a scheduler older than `no signed-in identity` answers `no identity` whenever no identity is free: it stays capacity
        if (refused.error === 'no slot' || refused.error === 'no identity') throw new NoCapacityError();
      }
      throw new Error('scheduler refused the run: 409');
    }
    if (res.status !== 201) throw new Error(`scheduler refused the run: ${res.status}`);
    const status = RunStatus.parse(await res.json());
    return { workerId: this.options.workerId, providerRunRef: status.runId };
  }

  /** Relays a command to the run's container (`POST /runs/:id/command`); a run the scheduler no longer holds is not an error. */
  async command(runId: string, command: ProviderCommand): Promise<void> {
    const res = await this.call(`/runs/${encodeURIComponent(runId)}/command`, { method: 'POST', body: command });
    if (res.status === 404) return; // the container is gone; the report that says so is on its way
    if (!res.ok) throw new Error(`scheduler refused the command: ${res.status}`);
  }

  /**
   * Removes the run's container and the scheduler's record of the run (`DELETE /runs/:id`). A run the scheduler no
   * longer holds has nothing left to remove; any other refusal throws, so the purge that called it tries again. The
   * provider keeps no copy of a run, so nothing of its own is deleted.
   */
  async deleteRun(input: { runId: string }): Promise<{ deleted: boolean }> {
    const res = await this.call(`/runs/${encodeURIComponent(input.runId)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`scheduler refused the delete: ${res.status}`);
    return { deleted: false }; // the worker's container and its record of the run go with the delete; the provider held neither
  }

  /** Each run the scheduler lists (`GET /runs`), alive or not, with the seconds it has counted. */
  async usage(input: { runIds?: string[] }): Promise<ProviderUsage[]> {
    const res = await this.call('/runs', { method: 'GET' });
    if (!res.ok) throw new Error(`scheduler runs unavailable: ${res.status}`);
    const statuses = RunStatus.array().parse(await res.json());
    const byId = new Map(statuses.map((s) => [s.runId, s]));
    const ids = input.runIds ?? [...byId.keys()];
    return ids.map((runId) => {
      const s = byId.get(runId);
      return { runId, alive: !!s && s.state !== 'exited', seconds: s?.seconds ?? 0 };
    });
  }
}
