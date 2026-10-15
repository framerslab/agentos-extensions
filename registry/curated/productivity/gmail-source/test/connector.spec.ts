import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ResumableAccountSourceConnector } from '@framers/agentos-ext-account-sources';
import { GmailSourceConnector, GmailConnectorFault, runGmailSourceSync, verifyGmailSource } from '../src/index.js';
import { connectorFixture, syncPolicy } from './connector-fixtures.js';
import { json, profileBody, gate, providerError } from './api-fixtures.js';
import { now, day, thread, message } from './mapping-fixtures.js';
const item = { id: 'abc123', title: 'Untrusted caller title', size: null, version: null };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded selected-id connector and resumable provider', () => {
  it('implements the original surface without treating empty ids as enumeration', async () => {
    const h = await connectorFixture(); const contract: ResumableAccountSourceConnector = h.connector;
    try {
      expect(contract.kind).toBe('gmail'); expect(contract.sync.kind).toBe('gmail');
      expect(await contract.list({ ids: [] })).toEqual({ items: [], gone: [] });
      expect(await contract.changesSince(null, { ids: [] })).toEqual({ changed: [], gone: [], cursor: '' });
      expect(await contract.changesSince('12', { ids: [] })).toEqual({ changed: [], gone: [], cursor: '12' });
      expect(h.calls).toEqual([]);
      expect(typeof runGmailSourceSync).toBe('function'); expect(typeof verifyGmailSource).toBe('function');
    } finally { h.connector.dispose(); }
  });
  it('binds identity before listing and obtains a fresh profile anchor for every begin', async () => {
    const h = await connectorFixture();
    try {
      expect(await h.connector.sync.begin(h.request())).toBe('9007199254740993123');
      expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['profile']);
      expect(await h.connector.sync.scanPage(h.request(), null)).toMatchObject({ ids: ['abc123'] });
      expect(h.accepted()).toBe(1);
      await h.connector.sync.begin(h.request({ cycleId: 'recovery-a' }));
      expect(h.accepted()).toBe(2);
      expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['profile', 'threads', 'profile']);
      expect(h.foundation.attempts.slice(0, 2).map((a) => a.mailboxKey)).toEqual(['opaque-owner-a', 'opaque-owner-a']);
      expect(h.foundation.attempts.slice(2).every((a) => a.mailboxKey === 'opaque-mailbox-a')).toBe(true);
    } finally { h.connector.dispose(); }
  });
  it('checks identity on resumed history before any history or mail request', async () => {
    const h = await connectorFixture();
    try {
      await h.connector.sync.historyPage(h.request(), '9007199254740993123', null);
      expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['profile', 'history']);
    } finally { h.connector.dispose(); }
    const denied = await connectorFixture(); denied.rejectIdentity();
    try {
      await expect(denied.connector.sync.readSource(denied.request(), 'abc123')).rejects.toMatchObject({ code: 'grant_rejected' });
      expect(denied.calls.map((c) => c.path.split('/').pop())).toEqual(['profile']);
    } finally { denied.connector.dispose(); }
  });
  it('uses the dynamic generation, refuses an old request and verifies the new generation again', async () => {
    const h = await connectorFixture(); const old = h.request();
    try {
      await h.connector.sync.begin(old); h.replaceHandle(2);
      await expect(h.connector.sync.scanPage(old, null)).rejects.toMatchObject({ code: 'grant_rejected' });
      await h.connector.sync.readSource(h.request(), 'abc123');
      expect(h.accepted()).toBe(2);
      expect(h.calls.filter((c) => c.path.endsWith('/labels'))).toHaveLength(1);
    } finally { h.connector.dispose(); }
  });
  it('fetches one label snapshot per cycle, clears expired names and clamps document life', async () => {
    vi.useFakeTimers();
    const h = await connectorFixture(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/profile')) return json(profileBody());
      if (path.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'Short label' }] }, 200, { 'cache-control': 'max-age=1' });
      return json(thread());
    });
    try {
      const a = await h.connector.sync.readSource(h.request(), 'abc123');
      expect(a.kind).toBe('document');
      if (a.kind !== 'document') throw new Error('expected_document');
      expect(a.document.cache.expiresAt).toBe(now + 1000);
      expect(JSON.stringify(a)).toContain('Short label');
      await h.connector.sync.readSource(h.request(), 'abc123');
      expect(h.calls.filter((c) => c.path.endsWith('/labels'))).toHaveLength(1);
      h.advance(1001); await vi.advanceTimersByTimeAsync(1001);
      const b = await h.connector.sync.readSource(h.request(), 'abc123');
      expect(JSON.stringify(b)).not.toContain('Short label');
      expect(h.calls.filter((c) => c.path.endsWith('/labels'))).toHaveLength(1);
      await h.connector.sync.readSource(h.request({ cycleId: 'cycle-b' }), 'abc123');
      expect(h.calls.filter((c) => c.path.endsWith('/labels'))).toHaveLength(2);
    } finally { h.connector.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drops an old label snapshot when permission changes and sends no content request on denial', async () => {
    const h = await connectorFixture();
    try {
      await h.connector.sync.readSource(h.request(), 'abc123'); const before = h.calls.length;
      h.denyPermission();
      expect(await h.connector.sync.readSource(h.request(), 'abc123')).toEqual({ kind: 'skipped', id: 'abc123', reason: 'not_permitted' });
      expect(h.calls).toHaveLength(before);
    } finally { h.connector.dispose(); }
  });
  it('lists only unique selected ids and returns the freshly mapped item rather than caller metadata', async () => {
    const h = await connectorFixture();
    try {
      const listed = await h.connector.list({ ids: ['abc123', 'abc123'] });
      expect(listed.items.map((entry) => entry.id)).toEqual(['abc123']);
      expect(listed.gone).toEqual([]); expect(listed.items[0]!.title).not.toBe(item.title);
      const read = await h.connector.read(item);
      expect('content' in read).toBe(true);
      expect(h.calls.filter((c) => c.path.endsWith('/threads'))).toHaveLength(0);
    } finally { h.connector.dispose(); }
  });
  it('does not fabricate removal for a skipped response or advance history on a skip', async () => {
    const h = await connectorFixture(); h.denyPermission();
    try {
      await expect(h.connector.read(item)).rejects.toMatchObject({ reason: 'skipped', skip: 'not_permitted' });
      await expect(h.connector.changesSince(null, { ids: ['abc123'] })).rejects.toMatchObject({ reason: 'skipped' });
    } finally { h.connector.dispose(); }
    const gone = await connectorFixture(async (input) => new URL(String(input)).pathname.endsWith('/profile')
      ? json(profileBody()) : new URL(String(input)).pathname.endsWith('/labels')
        ? json({ labels: [] }) : json(providerError('notFound'), 404));
    try { expect(await gone.connector.read(item)).toEqual({ id: 'abc123', reason: 'removed' }); }
    finally { gone.connector.dispose(); }
  });
  it('captures H0 before an initial selected read and returns it without a fabricated terminal history', async () => {
    const h = await connectorFixture();
    try {
      const result = await h.connector.changesSince(null, { ids: ['abc123'] });
      expect(result.cursor).toBe('9007199254740993123'); expect(result.changed).toHaveLength(1);
      expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['profile', 'labels', 'abc123']);
    } finally { h.connector.dispose(); }
  });
  it('drains history then rereads only selected changed ids, including deleted-message events', async () => {
    let page = 0;
    const h = await connectorFixture(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile')) return json(profileBody());
      if (url.pathname.endsWith('/labels')) return json({ labels: [] });
      if (url.pathname.endsWith('/history')) {
        page++;
        return json({ historyId: '9007199254740993125', ...(page === 1 ? { nextPageToken: 'next-a' } : {}), history: [{
          id: page === 1 ? '9007199254740993124' : '9007199254740993125',
          messagesDeleted: [{ message: { id: 'a2', threadId: 'abc123' } }],
          messagesAdded: [{ message: { id: 'b1', threadId: 'def456' } }],
        }] });
      }
      return json(thread([message('a1', 'Surviving body.', now - 1000)]));
    });
    try {
      const result = await h.connector.changesSince('9007199254740993123', { ids: ['abc123'] });
      expect(result.cursor).toBe('9007199254740993125'); expect(result.changed.map((entry) => entry.id)).toEqual(['abc123']);
      expect(result.gone).toEqual([]); expect(page).toBe(2);
      expect(h.calls.filter((call) => call.path.endsWith('/def456'))).toHaveLength(0);
    } finally { h.connector.dispose(); }
  });
  it('returns no facade cursor on history expiry or a page bound', async () => {
    for (const expired of [true, false]) {
      const h = await connectorFixture(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/profile')) return json(profileBody());
        return expired ? json(providerError('notFound'), 404)
          : json({ historyId: '9007199254740993124', nextPageToken: 'next-a' });
      });
      h.setPolicy({ ...syncPolicy, maxHistoryPagesPerLease: 1 });
      try {
        await expect(h.connector.changesSince('9007199254740993123', { ids: ['abc123'] })).rejects.toMatchObject(
          expired ? { code: 'history_expired' } : { reason: 'history_bound' });
      } finally { h.connector.dispose(); }
    }
  });
  it('refuses malformed or over-budget selections before HTTP', async () => {
    const h = await connectorFixture();
    try {
      for (const ids of [['../private'], Array.from({ length: 51 }, (_, n) => (n + 1).toString(16))]) {
        await expect(h.connector.list({ ids })).rejects.toBeInstanceOf(GmailConnectorFault);
      }
      expect(h.calls).toEqual([]);
    } finally { h.connector.dispose(); }
  });
  it('refuses late results after the handle fence changes', async () => {
    const entered = gate(); const finish = gate();
    const h = await connectorFixture(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/profile')) return json(profileBody());
      if (path.endsWith('/labels')) return json({ labels: [] });
      entered.resolve(); await finish.promise; return json(thread());
    });
    const pending = h.connector.sync.readSource(h.request(), 'abc123');
    const refused = expect(pending).rejects.toMatchObject({ code: 'grant_rejected' });
    await entered.promise; h.stop(); finish.resolve(); await refused; h.connector.dispose();
  });
  it('cancels in-flight work on disposal and rejects overlapping calls on one connector', async () => {
    const entered = gate(); const finish = gate();
    const h = await connectorFixture(async () => { entered.resolve(); await finish.promise; return json(profileBody()); });
    const pending = h.connector.sync.begin(h.request());
    const refused = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await entered.promise;
    await expect(h.connector.sync.begin(h.request())).rejects.toMatchObject({ reason: 'busy' });
    h.connector.dispose(); await refused; finish.resolve();
    await expect(h.connector.read(item)).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('revokes through the fenced lifecycle and leaves provider dispatch to the revoke worker', async () => {
    const h = await connectorFixture();
    await h.connector.revoke(); expect(h.calls).toEqual([]);
    await expect(h.connector.sync.begin(h.request())).rejects.toMatchObject({ code: 'cancelled' });
    expect(new GmailConnectorFault('history_bound').message).toBe('gmail_connector_history_bound');
  });
});
