/**
 * AgentOS's meeting-provider interface for Zoom through Realtime Media Streams. No participant joins the meeting and no
 * chat is read: the provider declares so, and a host writes its notice and its stop path from the declaration. A run is
 * registered with the media worker, then started at Zoom with its owner's token; Zoom confirms with a webhook, which
 * the host's route hands to `handleWebhook`, which hands it to the worker; the worker reports the run's life to the
 * host's events route, and forwards Zoom's own start and stop there under the run's token, where `verifyEvent` asks for
 * Zoom's signature as well.
 *
 * @module
 */
import {
  DispatchRefusedError,
  NoCapacityError,
  MemoryDurableInbox,
  type IDurableInbox,
  workerTokenMatches,
  type DispatchInput,
  type DispatchResult,
  type IMeetingBotProvider,
  type MeetingBotCapabilities,
  type MeetingLeaveReason,
  type MeetingPlatform,
  type MeetingRunRecord,
  type NormalizedMeetingEvent,
  type ProviderCommand,
  type ProviderEventContext,
  type ProviderParseResult,
  type ProviderUsage,
  type ProviderVerificationResult,
} from '@framers/agentos/io/channels/meetings';
import { ZoomApi, ZoomApiError } from './api.js';
import { checkZoomEligibility, refusalOfStart, type ZoomEligibility } from './eligibility.js';
import { parseZoomJoinUrl } from './links.js';
import { ZoomCommandAnswer, ZoomReportPost, ZoomRunStatus, zoomReportEventId, type ZoomStartRun } from './protocol.js';
import { ZoomNotConnectedError, type ZoomTokenKeeper } from './tokens.js';
import { ZOOM_SIGNATURE_HEADER, ZOOM_TIMESTAMP_HEADER, answerUrlValidation, eventsOfWebhook, headerOf, readZoomWebhook, verifyZoomWebhook, verifyFreshZoomWebhook, zoomDeliveryId, type HeaderBag, type ZoomWebhook } from './webhook.js';

/** A webhook delivery kept in the durable inbox until it is acted on: its headers, its raw body, and the connections it may concern. */
export interface ZoomInboxValue {
  headers: Record<string, string>;
  rawBody: string;
  connections?: Array<{ ownerRef: string; generation: string }>;
}

/** What the provider needs: the Zoom app's client id and webhook secret, the media worker's address, token and id, the token keeper, the API client, and the host's hooks (a run lookup, deauthorization, the durable inbox, connection binding, usage recording). */
export interface ZoomRtmsProviderOptions {
  /** Persisted by the host before a stream can start, retained after credential removal. */
  bindConnection?: (runId: string, generation: string) => Promise<void>;
  recordUsage?: (runId: string, usage: import('@framers/agentos/io/channels/meetings').SupplierUsage) => Promise<void>;
  inbox?: IDurableInbox<ZoomInboxValue>;
  clock?: () => number;
  /** The Zoom app's client id, which a start names. */
  clientId: string;
  /** The app's webhook secret token. */
  webhookSecret: string;
  /** The media worker's base address, and the credential it accepts from this provider. */
  workerUrl: string;
  workerToken: string;
  workerId: string;
  /** The owners' connections to Zoom. */
  tokens: ZoomTokenKeeper;
  api?: ZoomApi;
  /** The run a command names. A host passes its manager's `getRun`; without it, a leave the worker could not close is not stopped at Zoom. */
  runOf?: (runId: string) => Promise<MeetingRunRecord | undefined>;
  /** Resolves only after active and historical associated content has been purged. Credentials remain until then. */
  onDeauthorized?: (input: { zoomUserId: string; connections: Array<{ ownerRef: string; generation: string }> }) => Promise<void>;
  /** The identity the worker publishes under in a run's room. Default `bot`. */
  botIdentity?: string;
  fetchImpl?: typeof fetch;
  /** Where the provider's warnings go, each a run's id with a reason of the provider's own and never a word of a meeting. */
  logger?: { warn(message: string): void };
}

/** A body's text. */
function textOf(body: string | Buffer): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}

/** Whether a parsed body is one of Zoom's webhooks (it names an `event`) and not a worker's report (which names `type: 'report'`). */
function isZoomBody(json: unknown): boolean {
  return typeof json === 'object' && json !== null && typeof (json as { event?: unknown }).event === 'string' && (json as { type?: unknown }).type === undefined;
}

/**
 * AgentOS's meeting provider for Zoom through Realtime Media Streams. No participant joins the meeting: the provider checks
 * who may start a stream, registers the run with the media worker, starts and stops the stream through Zoom's API with the
 * owner's token, relays the manager's commands, and authenticates the worker's reports and Zoom's webhooks.
 */
export class ZoomRtmsProvider implements IMeetingBotProvider {
  readonly name = 'zoom-rtms';
  readonly platforms: readonly MeetingPlatform[] = ['zoom'];
  readonly capabilities: MeetingBotCapabilities = {
    joinsAsParticipant: false,
    postsChat: false,
    readsChat: false,
    audioPath: 'media_stream',
    recordsAudio: false,
    transcribes: false,
    keeps: 'nothing',
    stopPath: 'link',
  };
  readonly api: ZoomApi;
  private readonly fetch: typeof fetch;
  private readonly inbox: IDurableInbox<ZoomInboxValue>;
  private drainingInbox: Promise<void> | undefined;
  private readonly inboxTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: ZoomRtmsProviderOptions) {
    this.api = options.api ?? new ZoomApi({ fetchImpl: options.fetchImpl });
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.inbox = options.inbox ?? new MemoryDurableInbox<ZoomInboxValue>();
    this.inboxTimer = setInterval(() => { void this.drainInbox().catch(() => undefined); }, 1_000);
    this.inboxTimer.unref?.();
  }

  checkJoinUrl(url: string): { ok: true; platform: MeetingPlatform } | { ok: false; message: string } {
    const link = parseZoomJoinUrl(url);
    return link.ok ? { ok: true, platform: 'zoom' } : { ok: false, message: link.message };
  }

  /** A report needs the run's own token; one of Zoom's bodies needs Zoom's signature as well. */
  verifyEvent(ctx: ProviderEventContext, run: MeetingRunRecord | undefined): ProviderVerificationResult {
    const authorization = headerOf(ctx.headers, 'authorization');
    if (authorization === undefined || !authorization.startsWith('Bearer ')) return { valid: false, error: 'no bearer token' };
    if (run?.dispatch?.workerTokenHash === undefined) return { valid: false, error: 'the run has no dispatch record' };
    if (!workerTokenMatches(authorization.slice(7), run.dispatch.workerTokenHash)) return { valid: false, error: 'token mismatch' };
    const text = textOf(ctx.body);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { valid: false, error: 'not json' };
    }
    if (isZoomBody(json) && !verifyZoomWebhook({ secretToken: this.options.webhookSecret, headers: ctx.headers, rawBody: text })) {
      return { valid: false, error: "Zoom's signature did not verify" };
    }
    return { valid: true };
  }

  parseEvent(ctx: ProviderEventContext): ProviderParseResult {
    const text = textOf(ctx.body);
    const json: unknown = JSON.parse(text);
    if (isZoomBody(json)) {
      if (ctx.runId === undefined) throw new Error('a forwarded webhook names its run in the address');
      const webhook = readZoomWebhook(text);
      return { events: eventsOfWebhook(ctx.runId, webhook), rawData: { kind: webhook.kind } };
    }
    const post = ZoomReportPost.parse(json);
    const event: NormalizedMeetingEvent = { eventId: zoomReportEventId(post.runId, post.seq, post.event), runId: post.runId, type: post.event, at: post.at };
    // the report's schema admits the channel's leave reasons and the worker's own words alone, so its data is the event's as it stands
    if (post.data !== undefined) event.data = post.data;
    return { events: [event], rawData: { seq: post.seq, event: post.event } };
  }

  private worker(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    return this.fetch(`${this.options.workerUrl}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${this.options.workerToken}`, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
    });
  }

  /** Runs a call with the owner's token; a token Zoom refuses is refreshed once and the call made again. */
  private async withToken<T>(ownerRef: string, call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.options.tokens.accessToken(ownerRef);
    try {
      return await call(token);
    } catch (error) {
      if (!(error instanceof ZoomApiError) || error.status !== 401) throw error;
      return call(await this.options.tokens.accessToken(ownerRef, true));
    }
  }

  /** The person's place in the meeting, before a host reserves anything for the run. */
  async eligibility(ownerRef: string, meetingUrl: string): Promise<ZoomEligibility | { ok: false; reason: 'not_connected' | 'bad_link' }> {
    const link = parseZoomJoinUrl(meetingUrl);
    if (!link.ok) return { ok: false, reason: 'bad_link' };
    try {
      const connection = await this.options.tokens.connectionOf(ownerRef);
      if (connection === undefined || connection.closing) return { ok: false, reason: 'not_connected' };
      return await this.withToken(ownerRef, (token) => checkZoomEligibility(this.api, token, link.link.meetingNumber));
    } catch (error) {
      if (error instanceof ZoomNotConnectedError) return { ok: false, reason: 'not_connected' };
      if (error instanceof ZoomApiError && error.status === 401) return { ok: false, reason: 'not_connected' };
      throw error;
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const runId = input.run.runId;
    const owner = input.run.ownerRef;
    const link = parseZoomJoinUrl(input.run.meetingUrl);
    const zero = { streamSeconds: 0, captureSeconds: 0, final: true };
    if (!link.ok) {
      await this.options.recordUsage?.(runId, zero);
      throw new DispatchRefusedError('permission_denied', 'not_found');
    }
    let registered = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.options.tokens.accessToken(owner, attempt === 1);
        return await this.options.tokens.store.withRefreshLease(owner, async (store) => {
          const connection = await store.get(owner);
          if (connection === undefined || connection.closing) throw new ZoomNotConnectedError(owner, 'none');
          await this.options.bindConnection?.(runId, connection.generation);
          const start: ZoomStartRun = {
            runId, connectionGeneration: connection.generation, connectionCreatedAt: connection.createdAt,
            runGeneration: zoomDeliveryId(input.workerToken),
            requestedAt: input.run.dispatchedAt ?? input.run.joinAt,
            meetingNumber: link.link.meetingNumber, zoomUserId: connection.zoomUserId,
            livekit: { url: input.room.url, token: input.room.publishToken, identity: this.options.botIdentity ?? 'bot' },
            workerToken: input.workerToken, reportUrl: input.reportUrl, totalMs: input.run.limits.totalMs,
          };
          const accepted = await this.worker('/runs', { method: 'POST', body: start });
          if (accepted.status === 409) {
            const answer = await accepted.json() as { error?: string };
            if (answer.error === 'no slot') throw new NoCapacityError();
            throw new Error('run registration fenced');
          }
          if (accepted.status !== 201) throw new Error(`the media worker refused the run: ${accepted.status}`);
          registered = true;
          await this.api.setRtmsStatus(connection.accessToken, link.link.meetingNumber, 'start', {
            clientId: this.options.clientId, participantUserId: connection.zoomUserId,
          });
          return { workerId: this.options.workerId, providerRunRef: runId };
        });
      } catch (error) {
        // Release the lease before refreshing or recovering a stop.
        if (attempt === 0 && error instanceof ZoomApiError && error.status === 401) continue;
        if (registered) {
          // withdrawn, not killed: the worker posts no end of this attempt, which the manager retries or ends with its reason
          await this.closeRun(runId, { name: 'withdraw' });
          await this.deleteRun({ runId });
        } else if (error instanceof NoCapacityError || error instanceof ZoomNotConnectedError) {
          await this.options.recordUsage?.(runId, zero);
        }
        if (error instanceof ZoomNotConnectedError) throw new DispatchRefusedError('permission_denied', 'not_connected');
        if (error instanceof ZoomApiError) {
          const refusal = refusalOfStart(error);
          if (refusal !== undefined) throw new DispatchRefusedError(refusal === 'no_credits' ? 'no_capacity' : 'permission_denied', refusal);
        }
        throw error;
      }
    }
    throw new Error('start retry exhausted');
  }

  async command(runId: string, command: ProviderCommand): Promise<void> {
    if (command.name === 'postChat') return;
    if (command.name === 'leave' || command.name === 'kill') {
      await this.closeRun(runId, command.name === 'leave' ? { name: 'leave', reason: command.reason } : { name: 'kill' });
      return;
    }
    const response = await this.worker(`/runs/${encodeURIComponent(runId)}/command`, { method: 'POST', body: { name: command.name } });
    if (!response.ok) throw new Error('capture command unconfirmed');
  }

  /**
   * Ends a run at the worker and proves its stream closed: by the worker's own close request, or, when the worker could
   * not close it, does not know the run or cannot be reached, by Zoom's REST stop and the worker's acknowledgement of it.
   */
  private async closeRun(runId: string, body: { name: 'leave' | 'kill' | 'withdraw'; reason?: MeetingLeaveReason }): Promise<void> {
    let response: Response | undefined;
    try {
      response = await this.worker(`/runs/${encodeURIComponent(runId)}/command`, { method: 'POST', body });
    } catch {
      // an unreachable worker is answered by the stop through Zoom's API below
    }
    if (response?.ok) {
      const answer = ZoomCommandAnswer.parse(await response.json());
      if (answer.supplierUsage !== undefined) await this.options.recordUsage?.(runId, answer.supplierUsage);
      if (answer.closed) return;
    }
    // Missing workers, failed close responses and network faults all need an authoritative REST stop.
    await this.stopAtZoom(runId);
    const confirmed = await this.worker(`/runs/${encodeURIComponent(runId)}/command`, {
      method: 'POST', body: { name: 'confirmClosed', reason: body.name === 'leave' ? body.reason : 'stopped_by_owner' },
    });
    if (!confirmed.ok) throw new Error('closure acknowledgement pending');
    const answer = ZoomCommandAnswer.parse(await confirmed.json());
    if (answer.supplierUsage !== undefined) await this.options.recordUsage?.(runId, answer.supplierUsage);
    if (!answer.closed) throw new Error('closure acknowledgement pending');
  }

  private async stopAtZoom(runId: string): Promise<void> {
    const run = await this.options.runOf?.(runId);
    if (run === undefined) throw new Error('stop recovery run unavailable');
    const link = parseZoomJoinUrl(run.meetingUrl);
    if (!link.ok) throw new Error('stop recovery meeting unavailable');
    const connection = await this.options.tokens.connectionOf(run.ownerRef);
    if (connection === undefined || (run.providerConnectionRef !== undefined && connection.generation !== run.providerConnectionRef)) {
      throw new Error('stop recovery connection unavailable');
    }
    try {
      await this.withToken(run.ownerRef, (token) => this.api.setRtmsStatus(token, link.link.meetingNumber, 'stop', {
        clientId: this.options.clientId, participantUserId: connection.zoomUserId,
      }));
    } catch (error) {
      // Only these documented endpoint codes prove no stream remains. Other 4xx and all network faults retry.
      if (error instanceof ZoomApiError &&
          ((error.status === 400 && error.code === 13277) || (error.status === 404 && error.code === 3001))) return;
      throw error;
    }
  }

  async deleteRun(input: { runId: string }): Promise<{ deleted: boolean }> {
    const response = await this.worker(`/runs/${encodeURIComponent(input.runId)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error('stream closure pending');
    return { deleted: true }; // pending content-free reports remain until acknowledged
  }

  async usage(input: { runIds?: string[] }): Promise<ProviderUsage[]> {
    const response = await this.worker('/runs', { method: 'GET' });
    if (!response.ok) throw new Error(`the media worker's runs are unavailable: ${response.status}`);
    const statuses = ZoomRunStatus.array().parse(await response.json());
    for (const status of statuses) {
      if (status.state === 'ending') {
        // A run whose closure cannot be proved yet stays ending and is tried again on the next pass: it holds back no
        // other run's answer, which the host's reconciliation and dispatch recovery read.
        try {
          await this.command(status.runId, { name: 'kill' });
        } catch (error) {
          this.options.logger?.warn(`[ZoomRtmsProvider] closure of ${status.runId} pending: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      if (status.supplierUsage !== undefined) await this.options.recordUsage?.(status.runId, status.supplierUsage);
    }
    const byId = new Map(statuses.map((status) => [status.runId, status]));
    const ids = input.runIds ?? [...byId.keys()];
    return ids.map((runId) => {
      const status = byId.get(runId);
      return { runId, alive: status !== undefined && status.state !== 'ended', seconds: status?.seconds ?? 0,
        ...(status?.supplierUsage === undefined ? {} : { supplierUsage: status.supplierUsage }) };
    });
  }

  /** Stops the retry timer when the hosting process closes this provider. Pending rows remain durable. */
  close(): void { clearInterval(this.inboxTimer); }

  /** Ordered durable work; errors leave the current entry and all following entries pending. */
  drainInbox(): Promise<void> {
    if (this.drainingInbox !== undefined) return this.drainingInbox;
    this.drainingInbox = this.deliverInbox().finally(() => { this.drainingInbox = undefined; });
    return this.drainingInbox;
  }

  private async deliverInbox(): Promise<void> {
    for (const entry of await this.inbox.pending()) {
      const webhook = readZoomWebhook(entry.value.rawBody);
      if (webhook.kind === 'app_deauthorized') {
        const connections = entry.value.connections ?? [];
        if (this.options.onDeauthorized === undefined && connections.length > 0) throw new Error('deauthorization handler required');
        for (const connection of connections) {
          await this.options.tokens.store.withRefreshLease(connection.ownerRef, (store) => store.markClosing(connection.ownerRef, connection.generation));
        }
        await this.options.onDeauthorized?.({ zoomUserId: webhook.payload.user_id, connections });
        for (const target of connections) {
          await this.options.tokens.store.withRefreshLease(target.ownerRef, async (store) => {
            const held = await store.get(target.ownerRef);
            if (held?.generation === target.generation) await store.remove(target.ownerRef, held.version);
          });
        }
      } else {
        const response = await this.fetch(`${this.options.workerUrl}/zoom/webhook`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.workerToken}`, 'content-type': 'application/json',
            ...entry.value.headers, 'x-rtms-accepted-at': String(entry.acceptedAt) },
          body: entry.value.rawBody, redirect: 'error', signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) throw new Error(`webhook handover pending: ${response.status}`);
      }
      await this.inbox.acknowledge(entry.id);
    }
  }

  /** A 200 acknowledges durable acceptance, never a failed handover. */
  async handleWebhook(input: { headers: HeaderBag; rawBody: string }): Promise<{ status: number; body: unknown }> {
    const now = (this.options.clock ?? Date.now)();
    if (!verifyZoomWebhook({ secretToken: this.options.webhookSecret, ...input })) return { status: 401, body: { error: 'bad signature' } };
    let webhook: ZoomWebhook;
    try { webhook = readZoomWebhook(input.rawBody); }
    catch { return { status: 400, body: { error: 'unreadable' } }; }
    if (!verifyFreshZoomWebhook({ secretToken: this.options.webhookSecret, ...input, now })) return { status: 401, body: { error: 'expired delivery' } };
    if (webhook.kind === 'url_validation') return { status: 200, body: answerUrlValidation(this.options.webhookSecret, webhook.plainToken) };
    if (webhook.kind === 'other') return { status: 200, body: { ok: true } };
    const value: ZoomInboxValue = {
      rawBody: input.rawBody,
      headers: { [ZOOM_SIGNATURE_HEADER]: headerOf(input.headers, ZOOM_SIGNATURE_HEADER) ?? '',
        [ZOOM_TIMESTAMP_HEADER]: headerOf(input.headers, ZOOM_TIMESTAMP_HEADER) ?? '' },
    };
    if (webhook.kind === 'app_deauthorized') {
      if (webhook.payload.client_id !== this.options.clientId) return { status: 400, body: { error: 'wrong app' } };
      const endedAt = Math.min(webhook.at, Date.parse(webhook.payload.deauthorization_time));
      value.connections = (await this.options.tokens.store.byZoomUser(webhook.payload.user_id))
        .filter((row) => row.zoomAccountId === webhook.payload.account_id && row.createdAt <= endedAt)
        .map((row) => ({ ownerRef: row.ownerRef, generation: row.generation }));
    }
    try {
      await this.inbox.accept({ id: zoomDeliveryId(input.rawBody), acceptedAt: now, value });
    } catch { return { status: 503, body: { error: 'durable acceptance unavailable' } }; }
    void this.drainInbox().catch(() => undefined);
    return { status: 200, body: { ok: true } };
  }
}
