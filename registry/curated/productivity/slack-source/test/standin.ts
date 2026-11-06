/**
 * @fileoverview A loopback stand-in for Slack's Web API and OAuth, with synthetic channels, people, messages and
 * threads: it serves `oauth.v2.access` (the exchange and token rotation's refresh), `auth.revoke`, `apps.uninstall`,
 * `auth.test`, `team.info`, `users.info` and the `conversations` methods the read calls, counts every request, answers
 * a canned failure or a 429 with `Retry-After` on demand, and signs event envelopes as Slack does. It listens on
 * 127.0.0.1 alone, and on CI alone.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SLACK_READ_SCOPES, slackTs } from '../src/index.js';

/** Milliseconds in a day. */
export const day = 86_400_000;

/** A message as the stand-in holds it, in Slack's own shape. */
export interface RawMessage {
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  edited?: { user: string; ts: string };
  files?: { name: string }[];
  reply_count?: number;
}

/** A channel as the stand-in holds it. */
export interface RawChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
  is_ext_shared: boolean;
  /** The channel's messages, threads' parents among them; replies sit in `replies`. */
  messages: RawMessage[];
  /** Each thread's replies by its parent's timestamp. */
  replies: Record<string, RawMessage[]>;
}

/** One request the stand-in received. */
export interface Trace {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly token: string | null;
}

/** A canned answer. */
export interface Canned {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * A Slack timestamp at an instant, with a sequence number in its microseconds so two messages of one millisecond
 * differ.
 *
 * @param ms - Epoch milliseconds.
 * @param n - The sequence number, below 1,000.
 * @returns The timestamp.
 */
export function tsAt(ms: number, n = 0): string {
  const base = slackTs(ms);
  return `${base.slice(0, -3)}${String(n).padStart(3, '0')}`;
}

/** The stand-in. */
export class SlackStandin {
  /** Every request, in order. */
  readonly trace: Trace[] = [];
  /** The workspace's channels by id. */
  readonly channels = new Map<string, RawChannel>();
  /** The workspace's people by id. */
  readonly people = new Map<string, { name: string; email: string | null; deleted?: boolean }>();
  /** The access tokens the stand-in accepts. */
  readonly tokens = new Set<string>(['xoxe.xoxb-fixture-access']);
  /** The scope string the next exchange or refresh grants. */
  grantScope = SLACK_READ_SCOPES.join(',');
  /** The refresh tokens the stand-in has issued, in order. */
  readonly refreshes: string[] = [];
  /** The workspace. */
  team = { id: 'T0FIXTURE', name: 'Fixture Team', domain: 'fixture' };
  /** The bot user. */
  bot = { userId: 'U0BOT', botId: 'B0SAYSHERE' };
  private readonly canned = new Map<string, Canned[]>();
  private originValue = '';
  private issued = 0;
  private readonly server = createServer((request, response) => {
    void this.respond(request, response).catch(() => { response.statusCode = 599; response.end(); });
  });

  /** The stand-in's origin, `http://127.0.0.1:<port>`. */
  get origin(): string { assert.ok(this.originValue, 'standin_not_open'); return this.originValue; }

  /** Listens on loopback, on CI alone. */
  async open(): Promise<void> {
    assert.equal(process.env.CI, 'true', 'standin_ci_only');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.originValue = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Stops listening. */
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Adds a channel.
   *
   * @param channel - Its id and name, and any flag that differs from a public channel the bot is in.
   * @returns The channel.
   */
  channel(channel: Partial<RawChannel> & { id: string; name: string }): RawChannel {
    const made: RawChannel = { is_private: false, is_member: true, is_archived: false, is_ext_shared: false,
      messages: [], replies: {}, ...channel };
    this.channels.set(made.id, made); return made;
  }

  /**
   * Answers the next request of a method with a canned answer instead of its own.
   *
   * @param method - The method.
   * @param answer - The answer.
   */
  failNext(method: string, answer: Canned): void {
    const list = this.canned.get(method) ?? []; list.push(answer); this.canned.set(method, list);
  }

  /**
   * Answers the next request of a method with Slack's 429 and a `Retry-After` in seconds.
   *
   * @param method - The method.
   * @param seconds - The wait.
   */
  limitNext(method: string, seconds: number): void {
    this.failNext(method, { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': String(seconds) } });
  }

  /**
   * The requests of one method.
   *
   * @param method - The method.
   * @returns Their traces.
   */
  calls(method: string): Trace[] { return this.trace.filter((entry) => entry.method === method); }

  /**
   * A body Slack would post to the events route, with its signature headers.
   *
   * @param envelope - The envelope.
   * @param secret - The signing secret.
   * @param nowSeconds - The request's timestamp, epoch seconds.
   * @returns The raw body and the headers.
   */
  static signed(envelope: unknown, secret: string, nowSeconds: number): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(envelope);
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${nowSeconds}:${rawBody}`).digest('hex')}`;
    return { rawBody, headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': String(nowSeconds),
      'content-type': 'application/json' } };
  }

  /**
   * Answers one request.
   *
   * @param request - The request.
   * @param response - The response.
   */
  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const params = Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString('utf8')));
    const url = new URL(request.url ?? '/', this.origin);
    const method = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : url.pathname;
    const auth = request.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    this.trace.push({ method, params, token });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    const queued = this.canned.get(method);
    if (queued && queued.length > 0) { const answer = queued.shift()!; send(answer.status, answer.body, answer.headers); return; }
    if (method === 'oauth.v2.access') { send(200, this.oauth(params)); return; }
    if (method === 'apps.uninstall') { send(200, token !== null ? { ok: true } : { ok: false, error: 'invalid_auth' }); return; }
    if (token === null || !this.tokens.has(token)) { send(200, { ok: false, error: 'invalid_auth' }); return; }
    send(200, this.api(method, params));
  }

  /**
   * The OAuth exchange and refresh.
   *
   * @param params - The form.
   * @returns The answer.
   */
  private oauth(params: Record<string, string>): unknown {
    if (params.client_id !== 'fixture-client' || params.client_secret !== 'fixture-secret') return { ok: false, error: 'invalid_client_id' };
    if (params.grant_type === 'refresh_token') {
      if (!this.refreshes.includes(params.refresh_token ?? '')) return { ok: false, error: 'invalid_refresh_token' };
    } else if (params.code !== 'fixture-code') return { ok: false, error: 'invalid_code' };
    this.issued += 1;
    const access = `xoxe.xoxb-fixture-access-${this.issued}`;
    const refresh = `xoxe-1-fixture-refresh-${this.issued}`;
    this.tokens.add(access); this.refreshes.push(refresh);
    return {
      ok: true, app_id: 'A0FIXTURE', authed_user: { id: 'U0INSTALLER' }, scope: this.grantScope, token_type: 'bot',
      access_token: access, bot_user_id: this.bot.userId, refresh_token: refresh, expires_in: 43_200,
      team: { id: this.team.id, name: this.team.name }, enterprise: null, is_enterprise_install: false,
    };
  }

  /**
   * One Web API method.
   *
   * @param method - The method.
   * @param params - The form.
   * @returns The answer.
   */
  private api(method: string, params: Record<string, string>): unknown {
    const page = <T>(items: T[]): { slice: T[]; next: string | null } => {
      const offset = params.cursor?.startsWith('o:') ? Number(params.cursor.slice(2)) : 0;
      const limit = Number(params.limit ?? '100');
      const slice = items.slice(offset, offset + limit);
      return { slice, next: offset + limit < items.length ? `o:${offset + limit}` : null };
    };
    const channel = params.channel === undefined ? undefined : this.channels.get(params.channel);
    const shape = (raw: RawChannel) => ({ id: raw.id, name: raw.name, is_private: raw.is_private, is_member: raw.is_member,
      is_archived: raw.is_archived, is_ext_shared: raw.is_ext_shared, is_channel: !raw.is_private, is_group: false, is_im: false });
    switch (method) {
      case 'auth.revoke': return { ok: true, revoked: true };
      case 'auth.test': return { ok: true, team_id: this.team.id, user_id: this.bot.userId, bot_id: this.bot.botId };
      case 'team.info': return { ok: true, team: this.team };
      case 'users.info': {
        const person = this.people.get(params.user ?? '');
        if (!person) return { ok: false, error: 'user_not_found' };
        return { ok: true, user: { id: params.user, name: person.name.toLowerCase(), deleted: person.deleted === true,
          is_restricted: false, is_bot: false, profile: { display_name: person.name, email: person.email } } };
      }
      case 'conversations.list': {
        const types = (params.types ?? 'public_channel').split(',');
        const listed = [...this.channels.values()].filter((raw) => !(params.exclude_archived === 'true' && raw.is_archived)
          && ((types.includes('public_channel') && !raw.is_private)
            || (types.includes('private_channel') && raw.is_private && raw.is_member)));
        const { slice, next } = page(listed);
        return { ok: true, channels: slice.map(shape), response_metadata: { next_cursor: next ?? '' } };
      }
      case 'conversations.info': return channel ? { ok: true, channel: shape(channel) } : { ok: false, error: 'channel_not_found' };
      case 'conversations.join': {
        if (!channel) return { ok: false, error: 'channel_not_found' };
        if (channel.is_private) return { ok: false, error: 'method_not_supported_for_channel_type' };
        channel.is_member = true; return { ok: true, channel: shape(channel) };
      }
      case 'conversations.members': return channel ? { ok: true, members: [...this.people.keys()], response_metadata: { next_cursor: '' } }
        : { ok: false, error: 'channel_not_found' };
      case 'conversations.history': {
        if (!channel) return { ok: false, error: 'channel_not_found' };
        if (!channel.is_member) return { ok: false, error: 'not_in_channel' };
        const inclusive = params.inclusive === 'true';
        const within = (ts: string) => {
          const after = params.oldest === undefined || (inclusive ? ts >= params.oldest : ts > params.oldest);
          const before = params.latest === undefined || (inclusive ? ts <= params.latest : ts < params.latest);
          return after && before;
        };
        const listed = channel.messages.filter((message) => within(message.ts)).sort((a, b) => (a.ts < b.ts ? 1 : -1));
        const { slice, next } = page(listed);
        return { ok: true, messages: slice, has_more: next !== null, response_metadata: { next_cursor: next ?? '' } };
      }
      case 'conversations.replies': {
        if (!channel) return { ok: false, error: 'channel_not_found' };
        const parent = channel.messages.find((message) => message.ts === params.ts);
        if (!parent) return { ok: false, error: 'thread_not_found' };
        const replies = (channel.replies[parent.ts] ?? []).filter((reply) => params.oldest === undefined
          || (params.inclusive === 'true' ? reply.ts >= params.oldest : reply.ts > params.oldest))
          .sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const { slice, next } = page([parent, ...replies]);
        return { ok: true, messages: slice, has_more: next !== null, response_metadata: { next_cursor: next ?? '' } };
      }
      default: return { ok: false, error: 'unknown_method' };
    }
  }
}

/** One `run` the fixture quota admitted or deferred. */
export interface QuotaTrace {
  readonly method: string;
  readonly objects: number | undefined;
  readonly outcome: 'completed' | 'deferred';
}

/**
 * An in-memory stand-in for the account-source quota's `run`, `defer` and `ceilingOf`: each method's rolling minute per
 * workspace by its ceiling, the objects a request asks for, and a provider's wait for one method. The PostgreSQL suite
 * runs the released quota itself.
 */
export class FixtureQuota {
  /** Every `run`, in order. */
  readonly trace: QuotaTrace[] = [];
  /** Every `defer`, in order. */
  readonly defers: { readonly method: string | undefined; readonly retryAt: number }[] = [];
  private readonly sent = new Map<string, number[]>();
  private readonly waits = new Map<string, number>();

  /**
   * @param ceilings - The ceilings by method.
   * @param clock - The clock.
   * @param windowMs - The rolling window a ceiling counts over: a minute, or less so a case can wait it out.
   */
  constructor(private readonly ceilings: Readonly<Record<string, { perMinute: number; maxObjects?: number }>>,
    private readonly clock: () => number, private readonly windowMs = 60_000) {}

  /** The ceiling of a method, or null. */
  ceilingOf(method: string): { perMinute: number; maxObjects?: number } | null {
    return Object.hasOwn(this.ceilings, method) ? this.ceilings[method]! : null;
  }

  /** Admits one request, or defers it to its method's next room or wait. */
  async run<T>(request: { mailboxKey: string; method: string; objects?: number }, send: (signal: AbortSignal) => Promise<T>):
    Promise<{ kind: 'completed'; value: T } | { kind: 'deferred'; reason: 'method_minute' | 'provider_wait'; retryAt: number }> {
    const now = this.clock(); const key = `${request.mailboxKey}|${request.method}`;
    const ceiling = this.ceilingOf(request.method);
    if (ceiling?.maxObjects !== undefined && request.objects !== undefined && request.objects > ceiling.maxObjects) {
      throw new Error('fixture_quota_objects');
    }
    const wait = this.waits.get(key) ?? 0;
    if (wait > now) {
      this.trace.push({ method: request.method, objects: request.objects, outcome: 'deferred' });
      return { kind: 'deferred', reason: 'provider_wait', retryAt: wait };
    }
    const times = (this.sent.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (ceiling !== null && times.length >= ceiling.perMinute) {
      this.trace.push({ method: request.method, objects: request.objects, outcome: 'deferred' });
      return { kind: 'deferred', reason: 'method_minute', retryAt: times[0]! + this.windowMs + 1 };
    }
    times.push(now); this.sent.set(key, times);
    this.trace.push({ method: request.method, objects: request.objects, outcome: 'completed' });
    return { kind: 'completed', value: await send(new AbortController().signal) };
  }

  /** Records a provider's wait. */
  async defer(scope: { mailboxKey?: string; method?: string }, retryAt: number): Promise<void> {
    this.defers.push({ method: scope.method, retryAt });
    this.waits.set(`${scope.mailboxKey}|${scope.method}`, retryAt);
  }
}
