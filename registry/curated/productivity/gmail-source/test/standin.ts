import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GMAIL_READONLY_SCOPE, type GmailOAuthEndpoints } from '@framers/agentos-ext-gmail-source';

export const day = 86_400_000;
export const fixtureAddress = ['fixture', 'mail.invalid'].join(String.fromCharCode(64));
export const paths = {
  token: '/oauth/token', revoke: '/oauth/revoke', profile: '/gmail/v1/users/me/profile',
  list: '/gmail/v1/users/me/threads', labels: '/gmail/v1/users/me/labels', history: '/gmail/v1/users/me/history',
  thread: (id: string) => '/gmail/v1/users/me/threads/' + id,
};
export function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}
export async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('fixture_deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export interface Recording { readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> }
export interface RequestTrace { readonly method: string; readonly path: string; readonly anchor: string | null; readonly page: string | null }
export interface HeldResponse {
  readonly entered: ReturnType<typeof latch>; readonly resume: ReturnType<typeof latch>;
  readonly closed: ReturnType<typeof latch>; readonly phase: 'headers' | 'body';
  interrupted: boolean;
}
export const failure = (status: number, reason: string): Recording => ({ status,
  body: { error: { message: 'fixture-private-error', errors: [{ reason, message: 'fixture-private-error' }] } } });
export function mail(id: string, now: number, bodies = ['Fixture project budget.']) {
  return { id, historyId: '110', messages: bodies.map((body, n) => {
    const content = Buffer.from(body, 'utf8');
    return { id: id + (n + 1).toString(16), threadId: id, internalDate: String(now - 1000 + n),
      labelIds: ['INBOX'], payload: { mimeType: 'text/plain', filename: '', headers: [
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
        { name: 'Subject', value: 'Fixture subject' }, { name: 'From', value: fixtureAddress },
      ], body: { size: content.length, data: content.toString('base64url') } } };
  }) };
}
export function change(id: string, threadId: string, field: 'messagesAdded' | 'messagesDeleted' | 'labelsRemoved') {
  return { id, messages: [{ id: threadId + '1', threadId }],
    [field]: [{ message: { id: threadId + '1', threadId }, labelIds: ['INBOX'] }] };
}
async function form(request: IncomingMessage): Promise<URLSearchParams> {
  const parts: Buffer[] = []; let size = 0;
  for await (const value of request) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += bytes.length; assert.ok(size <= 65_536, 'fixture_form_cap'); parts.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}
export class GmailStandin {
  readonly trace: RequestTrace[] = [];
  readonly threads = new Map<string, unknown>();
  listIds = ['a1']; nextListToken: string | null = null; profileHistory = '100'; labelSeconds = 86400;
  history: (anchor: string, token: string | null) => unknown = () => ({ historyId: '110' });
  private readonly recordings = new Map<string, Recording[]>();
  private readonly holds = new Map<string, HeldResponse>();
  private readonly activeHolds = new Set<HeldResponse>();
  private violations = 0;
  private originValue = '';
  private readonly server = createServer((request, response) => {
    void this.respond(request, response).catch(() => { this.violations++; response.destroy(); });
  });
  constructor(private readonly clock: () => number) {}
  get origin(): string { assert.ok(this.originValue); return this.originValue; }
  get endpoints(): GmailOAuthEndpoints {
    return { authorization: this.origin + '/oauth/authorize', token: this.origin + paths.token, revoke: this.origin + paths.revoke };
  }
  async open(): Promise<void> {
    assert.equal(process.env.CI, 'true', 'fixture_ci_only');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject); resolve();
      });
    });
    this.originValue = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    this.threads.set('a1', mail('a1', this.clock()));
  }
  enqueue(path: string, recording: Recording): void {
    const queue = this.recordings.get(path) ?? []; queue.push(recording); this.recordings.set(path, queue);
  }
  hold(path: string, phase: HeldResponse['phase']): HeldResponse {
    assert.equal(this.holds.has(path), false);
    const held = { entered: latch(), resume: latch(), closed: latch(), phase, interrupted: false };
    this.holds.set(path, held); this.activeHolds.add(held); return held;
  }
  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const method = request.method ?? '';
    assert.equal(url.href.includes(fixtureAddress), false);
    let recording: Recording;
    if (url.pathname === paths.token) {
      assert.equal(method, 'POST'); const body = await form(request);
      assert.equal(body.get('client_id'), 'fixture-client'); assert.equal(body.get('client_secret'), 'fixture-secret');
      const grant = body.get('grant_type');
      assert.ok(grant === 'authorization_code' || grant === 'refresh_token');
      if (grant === 'authorization_code') {
        assert.equal(body.get('code'), 'fixture-code');
        assert.equal(body.get('redirect_uri'), 'https://consumer.invalid/callback');
        assert.match(body.get('code_verifier') ?? '', /^[A-Za-z0-9._~-]{43,128}$/);
      } else assert.equal(body.get('refresh_token'), 'fixture-refresh');
      recording = { status: 200, body: { access_token: 'fixture-access', refresh_token: 'fixture-refresh',
        token_type: 'Bearer', expires_in: 3600, scope: GMAIL_READONLY_SCOPE } };
    } else if (url.pathname === paths.revoke) {
      assert.equal(method, 'POST'); assert.equal((await form(request)).get('token'), 'fixture-refresh');
      recording = { status: 200, body: {} };
    } else {
      assert.equal(method, 'GET'); assert.equal(request.headers.authorization, 'Bearer fixture-access');
      if (url.pathname === paths.profile) recording = { status: 200,
        body: { emailAddress: fixtureAddress, historyId: this.profileHistory, messagesTotal: 2, threadsTotal: 2 } };
      else if (url.pathname === paths.labels) recording = { status: 200,
        body: { labels: [{ id: 'INBOX', name: 'Fixture short label' }] }, headers: { 'cache-control': 'max-age=' + this.labelSeconds } };
      else if (url.pathname === paths.list) {
        assert.match(url.searchParams.get('q') ?? '', /^after:\d+ before:\d+ -in:spam -in:trash -in:drafts$/);
        assert.equal(url.searchParams.get('includeSpamTrash'), 'false');
        assert.ok(Number(url.searchParams.get('maxResults')) >= this.listIds.length);
        recording = { status: 200, body: { threads: this.listIds.map((id) => ({ id, snippet: 'fixture-unused-snippet' })),
          ...(this.nextListToken ? { nextPageToken: this.nextListToken } : {}) } };
      } else if (url.pathname === paths.history) {
        const anchor = url.searchParams.get('startHistoryId'); assert.match(anchor ?? '', /^\d+$/);
        recording = { status: 200, body: this.history(anchor!, url.searchParams.get('pageToken')) };
      } else if (/^\/gmail\/v1\/users\/me\/threads\/[a-f0-9]+$/.test(url.pathname)) {
        assert.equal(url.searchParams.get('format'), 'full');
        const value = this.threads.get(url.pathname.split('/').at(-1)!);
        recording = value === undefined ? failure(404, 'notFound') : { status: 200, body: value };
      } else throw new Error('fixture_unexpected_endpoint');
    }
    this.trace.push({ method, path: url.pathname, anchor: url.searchParams.get('startHistoryId'), page: url.searchParams.get('pageToken') });
    recording = this.recordings.get(url.pathname)?.shift() ?? recording;
    const held = this.holds.get(url.pathname); this.holds.delete(url.pathname);
    const body = JSON.stringify(recording.body);
    const headers = { 'content-type': 'application/json', date: new Date(this.clock()).toUTCString(),
      'cache-control': 'max-age=86400', ...recording.headers };
    if (held) {
      response.once('close', () => { held.interrupted = !response.writableEnded; held.closed.resolve(); });
      if (held.phase === 'body') { response.writeHead(recording.status, headers); response.write(body.slice(0, 1)); }
      held.entered.resolve(); await held.resume.promise; this.activeHolds.delete(held);
      if (response.destroyed) return;
      if (held.phase === 'body') { response.end(body.slice(1)); return; }
    }
    response.writeHead(recording.status, headers); response.end(body);
  }
  async close(): Promise<void> {
    for (const held of this.activeHolds) held.resume.resolve();
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.server.closeAllConnections(); await bounded(closed);
    assert.equal(this.violations, 0, 'fixture_protocol_violation');
  }
}
