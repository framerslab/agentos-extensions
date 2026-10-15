import { describe, expect, it } from 'vitest';
import { GmailApi, type GmailTokenHolder } from '../src/index.js';
import { connectorFixture } from './connector-fixtures.js';
import { harness, json, profileBody } from './api-fixtures.js';
import { now, thread } from './mapping-fixtures.js';

describe('access token reuse within one sync lease', () => {
  it('refreshes once across a cycle, then again only after a 401 or on a new lease', async () => {
    let unauthorized = 0;
    const h = await connectorFixture(async (input) => {
      const path = new URL(String(input)).pathname;
      if (unauthorized > 0) { unauthorized--; return json({}, 401); }
      if (path.endsWith('/profile')) return json(profileBody());
      if (path.endsWith('/labels')) return json({ labels: [] });
      if (path.endsWith('/history')) return json({ historyId: '9007199254740993124' });
      if (path.endsWith('/threads')) return json({ threads: [{ id: 'abc123' }] });
      return json(thread());
    });
    try {
      await h.connector.sync.begin(h.request());
      await h.connector.sync.scanPage(h.request(), null);
      await h.connector.sync.historyPage(h.request(), '9007199254740993123', null);
      await h.connector.sync.readSource(h.request(), 'abc123');
      await h.connector.sync.readSource(h.request(), 'abc123');
      expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['profile', 'threads', 'history', 'labels', 'abc123', 'abc123']);
      expect(h.foundation.oauthCalls).toHaveLength(1);
      unauthorized = 1;
      expect(await h.connector.sync.readSource(h.request(), 'abc123')).toMatchObject({ kind: 'document' });
      expect(h.foundation.oauthCalls).toHaveLength(2);
      await h.connector.sync.readSource(h.request(), 'abc123');
      expect(h.foundation.oauthCalls).toHaveLength(2);
      h.replaceHandle(2);
      await h.connector.sync.readSource(h.request(), 'abc123');
      expect(h.foundation.oauthCalls).toHaveLength(3);
    } finally { h.connector.dispose(); }
  });
  it('shares a held token between clients on one lease until that lease expires', async () => {
    let at = now;
    const holder: GmailTokenHolder = { current: null };
    const h = await harness(async () => json(profileBody()), { clock: () => at, tokenHolder: holder });
    const owner = new GmailApi({ ...h.options, mailboxKey: 'opaque-owner-a' });
    await owner.profile(); await h.api.profile();
    expect(h.oauthCalls).toHaveLength(1); expect(h.grant.calls).toBe(1);
    expect(holder.current?.value).toBe('fixture-access');
    at = h.handle.lease.expiresAt;
    await h.api.profile();
    expect(h.oauthCalls).toHaveLength(2); expect(h.grant.calls).toBe(2);
  });
});
