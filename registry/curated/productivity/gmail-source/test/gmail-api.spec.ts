import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceSyncFault, type SourceQuota } from '@framers/agentos-ext-account-sources';
import { GmailApi } from '../src/index.js';
import { harness, json, profileBody, providerError, fixtureAddress, gate, readOptions, oauthUrl } from './api-fixtures.js';
import { bounds, now, day, thread } from './mapping-fixtures.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bounded Gmail API', () => {
  it('requests only me and fixed GET paths, and returns only needed profile fields', async () => {
    const h = await harness(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
      expect(init?.credentials).toBe('omit'); expect(init?.referrerPolicy).toBe('no-referrer');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-access');
      expect(url.href).not.toContain(fixtureAddress);
      return json({ ...profileBody(), raw: 'never-returned' });
    });
    expect(await h.api.profile()).toEqual({ emailAddress: fixtureAddress, historyId: '9007199254740993123' });
    expect(h.attempts.map((a) => a.method)).toEqual(['profile', 'profile']);
    expect(new Set(h.attempts.map((a) => a.attemptId)).size).toBe(2);
    expect(h.grant.calls).toBe(1);
  });
  it('constructs a time-only bounded list query and discards snippets and estimates', async () => {
    const h = await harness(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('q')).toBe(`after:${Math.max(0, Math.floor((now - 30 * day) / 1000) - 1)} before:${Math.floor(now / 1000) + 1} -in:spam -in:trash -in:drafts`);
      expect(url.searchParams.get('includeSpamTrash')).toBe('false');
      expect(url.searchParams.get('maxResults')).toBe('100');
      expect(url.searchParams.get('pageToken')).toBe('fixture-page');
      return json({ threads: [{ id: 'a1', snippet: 'private-snippet' }, { id: 'a2' }], resultSizeEstimate: 99999 });
    });
    expect(await h.api.list(now, 30 * day, 100, 'fixture-page')).toEqual({ kind: 'scan', ids: ['a1', 'a2'], nextPageToken: null });
    expect(h.attempts.map((a) => a.method)).toEqual(['profile', 'list']);
  });
  it('deduplicates every history event form and preserves large string anchors', async () => {
    const anchor = '9007199254740993000';
    const h = await harness(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('startHistoryId')).toBe(anchor);
      expect(url.searchParams.has('historyTypes')).toBe(false); expect(url.searchParams.has('labelId')).toBe(false);
      return json({ historyId: '9007199254740993123', nextPageToken: 'next-fixture', history: [{ id: '9007199254740993100',
        messages: [{ id: '1', threadId: 'a1', snippet: 'private-history' }],
        messagesAdded: [{ message: { id: '1', threadId: 'a1' } }],
        messagesDeleted: [{ message: { id: '2', threadId: 'a2' } }],
        labelsAdded: [{ message: { id: '3', threadId: 'a3' }, labelIds: ['INBOX'] }],
        labelsRemoved: [{ message: { id: '4', threadId: 'a4' }, labelIds: ['INBOX'] }],
      }] });
    });
    expect(await h.api.history(anchor, 100, null)).toEqual({ kind: 'history', ids: ['a1', 'a2', 'a3', 'a4'],
      nextPageToken: 'next-fixture', cursor: '9007199254740993123' });
  });
  it('rejects malformed control pages without treating them as successful empty pages', async () => {
    const cases: readonly [unknown, 'list' | 'history' | 'profile'][] = [
      [{ threads: [{ id: 'bad/path' }] }, 'list'], [{ threads: null }, 'list'],
      [{ threads: [], nextPageToken: 'fixture-page' }, 'list'],
      [{ historyId: '2', history: [{ id: '3', messages: [] }] }, 'history'],
      [{ historyId: 9007199254740993 }, 'history'],
      [{ historyId: '2', history: [{ id: '2', messagesDeleted: [{ message: {} }] }] }, 'history'],
      [{ emailAddress: '\nprivate', historyId: '2' }, 'profile'],
    ];
    for (const [body, method] of cases) {
      const h = await harness(async () => json(body));
      const pending = method === 'list' ? h.api.list(now, day, 100, 'fixture-page')
        : method === 'history' ? h.api.history('1', 100, null) : h.api.profile();
      await expect(pending).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('sanitizes labels and independently enforces their response cache permission', async () => {
    const h = await harness(async () => json({ labels: [{ id: 'INBOX', name: fixtureAddress },
      { id: 'Label_7', name: 'password=fixture-secret', messagesTotal: 500 }] }, 200, { 'cache-control': 'max-age=2' }));
    const labels = await h.api.labels({ evidenceId: 'fixture-labels', retentionMs: day });
    expect(labels.names).toEqual({ INBOX: '[address removed]', Label_7: '[secret removed]' });
    expect(labels.cache).toMatchObject({ kind: 'cache', expiresAt: now + 2000 });
    expect(JSON.stringify(labels)).not.toContain(fixtureAddress);
    const denied = await harness(async () => json({ labels: [{ id: 'INBOX', name: 'private-label' }] }, 200, { 'cache-control': 'no-store' }));
    expect(await denied.api.labels({ evidenceId: 'fixture-labels', retentionMs: day }))
      .toEqual({ names: {}, cache: { kind: 'skip', reason: 'no_store' } });
  });
  it('passes the thread read times and headers and the separate label expiry to the mapper', async () => {
    let at = now;
    const h = await harness(async (input) => {
      expect(new URL(String(input)).pathname).toBe('/gmail/v1/users/me/threads/abc123');
      expect(new URL(String(input)).searchParams.get('format')).toBe('full');
      at += 100;
      return json(thread(), 200, { 'cache-control': 'max-age=60' });
    }, { clock: () => at });
    const result = await h.api.readThread('abc123', readOptions({ labels: {
      names: { INBOX: 'Inbox' }, cache: { kind: 'cache', expiresAt: now + 3000, evidenceId: 'fixture-labels' },
    } }));
    expect(result.kind).toBe('document');
    if (result.kind !== 'document') throw new Error('expected_document');
    expect(result.document.cache.expiresAt).toBe(now + 3000);
    expect(result.document.read.ref.readAt).toBe(new Date(now + 100).toISOString());
    const refused = await harness(async () => json(thread(), 200, { 'cache-control': 'no-store' }));
    expect(await refused.api.readThread('abc123', readOptions())).toMatchObject({ kind: 'skipped', reason: 'no_store' });
  });
  it('refreshes once after 401 and charges each dispatch separately', async () => {
    let calls = 0;
    const h = await harness(async () => ++calls === 1 ? json(providerError('authError'), 401) : json(profileBody()));
    expect((await h.api.profile()).historyId).toBe('9007199254740993123');
    expect(calls).toBe(2); expect(h.grant.calls).toBe(2); expect(h.attempts).toHaveLength(4);
    expect(new Set(h.attempts.map((a) => a.attemptId)).size).toBe(4);
    const failed = await harness(async () => json(providerError('authError'), 401));
    await expect(failed.api.profile()).rejects.toMatchObject({ code: 'grant_rejected' });
    expect(failed.grant.calls).toBe(2); expect(failed.attempts).toHaveLength(4);
  });
  it('translates refresh failures inside the grant operation and respects its final fence', async () => {
    const h = await harness(async () => json(profileBody()));
    const send: typeof fetch = async (input) => String(input) === oauthUrl
      ? json({ error: 'invalid_grant', error_description: 'private-fixture' }, 400) : json(profileBody());
    const denied = new GmailApi({ ...h.options, fetchImpl: send });
    await expect(denied.profile()).rejects.toMatchObject({ code: 'grant_rejected' });
    h.grant.failAfter = true;
    await expect(h.api.profile()).rejects.toMatchObject({ code: 'grant_rejected' });
    expect(h.attempts.filter((a) => a.method === 'profile')).toHaveLength(2);
    expect(h.oauthCalls).toHaveLength(1);
  });
  it('persists longer Retry-After without inline retry and keeps daily/project waits distinct', async () => {
    for (const [status, reason, scope, minimum] of [
      [429, 'userRateLimitExceeded', 'mailbox', 172_800_000],
      [403, 'rateLimitExceeded', 'project', 172_800_000],
      [403, 'dailyLimitExceeded', 'project', 172_800_000],
    ] as const) {
      let calls = 0;
      const h = await harness(async () => { calls++; return json(providerError(reason), status, { 'retry-after': '172800' }); });
      await expect(h.api.profile()).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + minimum });
      expect(calls).toBe(1); expect(h.waits).toHaveLength(1);
      expect(h.waits[0]!.scope).toEqual(scope === 'project'
        ? { projectKey: 'project-a' } : { projectKey: 'project-a', mailboxKey: 'opaque-mailbox-a' });
    }
  });
  it('preserves status retries for invalid error JSON and never retries a domain restriction', async () => {
    const h = await harness(async () => new Response('<private failure>', { status: 503 }));
    await expect(h.api.profile()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(h.waits).toHaveLength(1);
    const domain = await harness(async () => json(providerError('domainPolicy'), 403));
    await expect(domain.api.profile()).rejects.toMatchObject({ code: 'domain_policy' });
    expect(domain.waits).toHaveLength(0);
  });
  it('maps thread 404 to gone and history 404 to recovery, with no account-wide purge here', async () => {
    const h = await harness(async () => json(providerError('notFound'), 404));
    expect(await h.api.readThread('abc123', readOptions())).toEqual({ kind: 'gone', id: 'abc123' });
    await expect(h.api.history('1', 100, null)).rejects.toMatchObject({ code: 'history_expired' });
    await expect(h.api.profile()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('sends no HTTP when the shared quota defers and refuses duplicate attempt grants', async () => {
    for (const duplicate of [false, true]) {
      const send = vi.fn(async () => json(profileBody()));
      const quota: Pick<SourceQuota, 'run' | 'defer'> = {
        run: async () => duplicate ? { kind: 'duplicate' } : { kind: 'deferred', reason: 'project_day', retryAt: now + day },
        defer: async () => {},
      };
      const h = await harness(send, { quota });
      await expect(h.api.profile()).rejects.toMatchObject(duplicate ? { code: 'invalid_response' } : { code: 'rate_limited', retryAt: now + day });
      expect(send).not.toHaveBeenCalled(); expect(h.oauthCalls).toHaveLength(0);
    }
  });
  it('answers a late quota start as a retryable wait, sending nothing, unlike a reused attempt id', async () => {
    for (const late of [true, false]) {
      const send = vi.fn(async () => json({ threads: [] }));
      const h = await harness(send);
      // The refresh's reservation completes; the list call's start misses its send window or reuses an attempt id.
      const quota: Pick<SourceQuota, 'run' | 'defer'> = {
        run: async (request, work, signal) => request.method === 'profile' ? h.options.quota.run(request, work, signal)
          : late ? { kind: 'late', retryAt: now + 1000 } : { kind: 'duplicate' },
        defer: async () => {},
      };
      const api = new GmailApi({ ...h.options, quota });
      await expect(api.list(now, day, 100, null)).rejects.toMatchObject(late
        ? { code: 'rate_limited', retryAt: now + 1000 } : { code: 'invalid_response' });
      expect(h.oauthCalls).toHaveLength(1); expect(send).not.toHaveBeenCalled();
    }
  });
  it('hands back no retry time at or before its own clock, whichever clock produced it', async () => {
    // The quota's times come from the database clock, which can lag the clock the host's sync store compares with.
    for (const result of [{ kind: 'deferred', reason: 'project_minute', retryAt: now - 5000 }, { kind: 'late', retryAt: now }] as const) {
      const send = vi.fn(async () => json(profileBody()));
      const h = await harness(send, { quota: { run: async () => result, defer: async () => {} } });
      await expect(h.api.profile()).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + 1 });
      expect(send).not.toHaveBeenCalled();
    }
    // A grant lease that another worker holds answers its expiry, which can pass before the caller reads it.
    const h = await harness(async () => json(profileBody()));
    const busy = new GmailApi({ ...h.options, revocations: { withGrant: async () => { throw new SourceSyncFault('rate_limited', now); } } });
    await expect(busy.profile()).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + 1 });
    // Recording a provider wait can take long; the time handed back still follows the clock that read it.
    let at = now; const recorded: number[] = [];
    const slow = await harness(async () => json(providerError('userRateLimitExceeded'), 429, { 'retry-after': '60' }), { clock: () => at });
    const api = new GmailApi({ ...slow.options, quota: { run: slow.options.quota.run,
      defer: async (_scope, retryAt) => { recorded.push(retryAt); at += 120_000; } } });
    await expect(api.profile()).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + 120_001 });
    expect(recorded).toEqual([now + 60_000]);
  });
  it('caps declared and streamed response bytes, cancels bodies and refuses oversized control pages', async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const h = await harness(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(bounds.maxResponseBytes + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { 'content-length': String(bounds.maxResponseBytes + 1) } : {} }));
      expect(await h.api.readThread('abc123', readOptions())).toEqual({ kind: 'skipped', id: 'abc123', reason: 'response_too_large' });
      expect(cancelled).toBe(true);
      await expect(h.api.profile()).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('rejects malformed UTF-8 and successful JSON, and cannot follow redirects', async () => {
    for (const response of [() => new Response(Uint8Array.of(0xc3, 0x28)),
      () => new Response('{bad-json'), () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } })]) {
      const h = await harness(async () => response());
      await expect(h.api.profile()).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
  it('cancels stalled bodies on parent abort and timeout, and rejects late fetch delivery', async () => {
    const entered = gate(); let cancelled = false;
    const h = await harness(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { entered.resolve(); }, cancel() { cancelled = true; },
    })));
    const parent = new AbortController(); const running = h.api.profile(parent.signal);
    const aborted = expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await entered.promise; parent.abort(); await aborted; expect(cancelled).toBe(true);
    vi.useFakeTimers(); let timeoutCancelled = false;
    const timeout = await harness(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { timeoutCancelled = true; } })));
    const timed = expect(timeout.api.profile()).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(15_001); await timed; expect(timeoutCancelled).toBe(true); vi.useRealTimers();
    const called = gate(); const finish = gate(); const discarded = gate();
    const late = await harness(async () => { called.resolve(); await finish.promise;
      return new Response(new ReadableStream<Uint8Array>({ cancel() { discarded.resolve(); } })); });
    const stop = new AbortController(); const pending = late.api.profile(stop.signal);
    const refused = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await called.promise; stop.abort(); await refused; finish.resolve(); await discarded.promise;
  });
  it('refuses unsafe construction and input before API dispatch', async () => {
    const h = await harness(async () => json(profileBody()));
    vi.stubEnv('CI', '');
    expect(() => new GmailApi({ ...h.options, apiOrigin: 'https://fixture.invalid' })).toThrow('gmail_api_configuration');
    vi.stubEnv('CI', 'true');
    for (const apiOrigin of ['https://external.example', 'https://fixture.invalid/path', 'https://user:secret@fixture.invalid', 'https://fixture.invalid?x=1']) {
      expect(() => new GmailApi({ ...h.options, apiOrigin })).toThrow('gmail_api_configuration');
    }
    expect(() => new GmailApi({ ...h.options, limits: { ...h.options.limits, timeoutMs: 15_001 } })).toThrow('gmail_api_configuration');
    await expect(h.api.list(now, day, 101, null)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(h.api.readThread('../private', readOptions())).rejects.toMatchObject({ code: 'invalid_response' });
    expect(h.attempts).toHaveLength(0);
  });
  it('keeps refresh provider waits and timeout classification inside the grant boundary', async () => { const h = await harness(async () => json(profileBody())); const transient = new GmailApi({ ...h.options, fetchImpl: async () => json({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '172800' }) }); await expect(transient.profile()).rejects.toMatchObject({ code: 'provider_unavailable', retryAt: now + 172800000 }); expect(h.waits).toHaveLength(1); const client = new GmailApi({ ...h.options, fetchImpl: async () => json({ error: 'invalid_client' }, 401) }); await expect(client.profile()).rejects.toMatchObject({ code: 'invalid_response' }); vi.useFakeTimers(); const entered = gate(); let cancelled = false; const timeout = new GmailApi({ ...h.options, fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { cancelled = true; } })) }); const pending = expect(timeout.profile()).rejects.toMatchObject({ code: 'network' }); await entered.promise; await vi.advanceTimersByTimeAsync(15001); await pending; expect(cancelled).toBe(true); });   it('has no console side effect or raw error leakage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness(async () => { throw new Error('private-transport-text'); });
    await expect(h.api.profile()).rejects.toMatchObject({ code: 'network', message: 'source_sync_network' });
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
});
