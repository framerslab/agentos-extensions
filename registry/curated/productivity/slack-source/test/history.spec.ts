import { afterEach, describe, expect, it } from 'vitest';
import { SourceSyncFault } from '@framers/agentos-ext-account-sources';
import { SLACK_CHANNEL_LEFT, slackDayOf, slackTs, slackWindowSlice, slackWithin } from '../src/index.js';
import { day, tsAt } from './standin.js';
import { basePolicy, connectedAt, openSlack, request, walk, type SlackFixture } from './fixture.js';

let fixture: SlackFixture | null = null;
afterEach(async () => { await fixture?.close(); fixture = null; });

/** A public channel the bot is in, with one message on the connect day and one on the next. */
async function general(options: Parameters<typeof openSlack>[0] = {}): Promise<SlackFixture> {
  fixture = await openSlack(options);
  fixture.standin.people.set('U0ADA', { name: 'Ada', email: null });
  fixture.standin.channel({ id: 'C0GENERAL', name: 'general', messages: [
    { ts: tsAt(connectedAt + 3_600_000), user: 'U0ADA', text: 'Kickoff' },
    { ts: tsAt(connectedAt + day + 3_600_000), user: 'U0ADA', text: 'Budget is final' },
  ] });
  return fixture;
}

describe('the anchor per channel', () => {
  it('begins from the newest channel anchor, or before every message for a connection that read none', async () => {
    const f = await general();
    const connector = f.connector();
    expect(await connector.sync.begin(request(f.clock.now))).toBe('0.000000');
    expect(await connector.sync.begin(request(f.clock.now, { subCursors: {
      C0GENERAL: slackTs(connectedAt + day), C0RANDOM: slackTs(connectedAt + 2 * day) } }))).toBe(slackTs(connectedAt + 2 * day));
  });

  it("reads a channel never read from its read-from bound, and one read before from its anchor, staging the walk's cutoff", async () => {
    const f = await general();
    const connector = f.connector();
    const cutoff = f.clock.now;
    const first = await walk(connector, request(cutoff), '0.000000');
    const [listed] = f.standin.calls('conversations.list');
    expect(listed?.params).toMatchObject({ types: 'public_channel,private_channel', exclude_archived: 'true' });
    const [read] = f.standin.calls('conversations.history');
    expect(read?.params).toMatchObject({ channel: 'C0GENERAL', oldest: slackTs(connectedAt), latest: slackTs(cutoff),
      inclusive: 'true' });
    expect(first.ids).toEqual(['C0GENERAL:2026-11-03', 'C0GENERAL:2026-11-02']);
    expect(first.subCursors).toEqual({ C0GENERAL: slackTs(cutoff) });
    expect(first.cursor).toBe(slackTs(cutoff));

    const next = cutoff + day;
    const second = await walk(connector, request(next, { subCursors: first.subCursors }), first.cursor);
    const reread = f.standin.calls('conversations.history')[1];
    expect(reread?.params).toMatchObject({ channel: 'C0GENERAL', oldest: slackTs(cutoff), latest: slackTs(next), inclusive: 'false' });
    expect(second.subCursors).toEqual({ C0GENERAL: slackTs(next) });
    expect(second.ids).toEqual(slackWindowSlice(connectedAt, next, 90).map((date) => `C0GENERAL:${date}`));
  });

  it('sends no request between walks: the live read is the events', async () => {
    const f = await general();
    const connector = f.connector();
    const cutoff = f.clock.now;
    const page = await connector.sync.historyPage(request(cutoff + 3_600_000, { subCursors: { C0GENERAL: slackTs(cutoff) } }),
      slackTs(cutoff), null);
    expect(page).toEqual({ kind: 'history', ids: [], nextPageToken: null, cursor: slackTs(cutoff) });
    expect(await connector.sync.scanPage(request(cutoff), null)).toEqual({ kind: 'scan', ids: [], nextPageToken: null });
    expect(f.standin.trace).toEqual([]);
  });

  it('walks once a reconcile period when the set reads no channel', async () => {
    fixture = await openSlack();
    fixture.standin.channel({ id: 'C0RANDOM', name: 'random', is_member: false, messages: [] });
    const connector = fixture.connector();
    const cutoff = fixture.clock.now;
    const first = await walk(connector, request(cutoff), '0.000000');
    expect(first.subCursors).toEqual({});
    expect(first.cursor).toBe(slackTs(cutoff));
    const sent = fixture.standin.trace.length;
    const page = await connector.sync.historyPage(request(cutoff + 3_600_000), first.cursor, null);
    expect(page).toEqual({ kind: 'history', ids: [], nextPageToken: null, cursor: first.cursor });
    expect(fixture.standin.trace).toHaveLength(sent);
  });
});

describe('a channel the set has left', () => {
  it("names each day a channel read before may hold once Slack does not have it, shares it with another organisation or the set leaves it, once, and leaves an archived channel's days to expire", async () => {
    const f = await general();
    f.standin.channel({ id: 'C0SHARED', name: 'partner', is_ext_shared: true, messages: [] });
    f.standin.channel({ id: 'C0LEFT', name: 'left', is_member: false, messages: [] });
    f.standin.channel({ id: 'C0OLD', name: 'old', is_archived: true, messages: [] });
    const cutoff = f.clock.now;
    const before = slackTs(cutoff - day);
    const anchored = { C0GENERAL: before, C0SHARED: before, C0LEFT: before, C0OLD: before, C0GONE: before };
    const result = await walk(f.connector(), request(cutoff, { subCursors: anchored }), before);
    const daysOf = (channel: string) => ['2026-11-05', '2026-11-04', '2026-11-03', '2026-11-02'].map((date) => `${channel}:${date}`);
    expect(result.ids.filter((id) => !id.startsWith('C0GENERAL:')))
      .toEqual([...daysOf('C0GONE'), ...daysOf('C0LEFT'), ...daysOf('C0SHARED')]);
    expect(result.subCursors).toEqual({ C0GENERAL: slackTs(cutoff), C0GONE: SLACK_CHANNEL_LEFT, C0LEFT: SLACK_CHANNEL_LEFT,
      C0SHARED: SLACK_CHANNEL_LEFT });
    expect(f.standin.calls('conversations.info').map((call) => call.params.channel))
      .toEqual(['C0GENERAL', 'C0GONE', 'C0LEFT', 'C0OLD', 'C0SHARED']);
    for (const id of [...daysOf('C0GONE'), ...daysOf('C0LEFT'), ...daysOf('C0SHARED')]) {
      expect(await f.connector().sync.readSource(request(cutoff), id)).toEqual({ kind: 'gone', id });
    }
    const asked = f.standin.calls('conversations.info').length;
    const next = await walk(f.connector(), request(cutoff + day, { subCursors: { ...anchored, ...result.subCursors } }), result.cursor);
    expect(next.ids.filter((id) => !id.startsWith('C0GENERAL:'))).toEqual([]);
    expect(f.standin.calls('conversations.info').slice(asked).map((call) => call.params.channel)).toEqual(['C0GENERAL', 'C0OLD']);
  });

  it("names a long-read channel's days a hundred a page", async () => {
    const f = await general();
    const cutoff = f.clock.now;
    const before = slackTs(cutoff - day);
    const result = await walk(f.connector({ retainedDays: 200, backfillDays: 150 }), request(cutoff, { subCursors: { C0GONE: before } }),
      before);
    const named = result.pages.map((page) => page.ids.filter((id) => id.startsWith('C0GONE:')).length).filter((n) => n > 0);
    expect(named).toEqual([100, 54]);
    const days = result.ids.filter((id) => id.startsWith('C0GONE:'));
    expect([days[0], days[153]]).toEqual([`C0GONE:${slackDayOf(cutoff)}`, `C0GONE:${slackDayOf(connectedAt - 150 * day)}`]);
    expect(result.subCursors).toMatchObject({ C0GONE: SLACK_CHANNEL_LEFT });
  });
});

describe('the backfill days', () => {
  it.each([14, 30])('reads a channel from the connect day less %i days, the days the host sends', async (days) => {
    const f = await general();
    await walk(f.connector({ backfillDays: days }), request(f.clock.now), '0.000000');
    const [read] = f.standin.calls('conversations.history');
    expect(read?.params.oldest).toBe(slackTs(connectedAt - days * day));
  });

  it("holds no number of its own: the retained days are the host's, and backfill days outside 1 to them are refused", async () => {
    const f = await general();
    expect(() => f.connector({ retainedDays: 30, backfillDays: 31 })).toThrow('slack_connector_configuration');
    expect(() => f.connector({ backfillDays: 0 })).toThrow('slack_connector_configuration');
    expect(() => f.connector({ retainedDays: 0 })).toThrow('slack_connector_configuration');
    expect(() => f.connector({ retainedDays: undefined })).toThrow('slack_connector_configuration');
    await walk(f.connector({ retainedDays: 120, backfillDays: 100 }), request(f.clock.now), '0.000000');
    const [read] = f.standin.calls('conversations.history');
    expect(read?.params.oldest).toBe(slackTs(connectedAt - 100 * day));
  });

  it("never reads a channel from before the host's retained days", async () => {
    const f = await general();
    await walk(f.connector({ retainedDays: 30, backfillDays: 30 }), request(f.clock.now), '0.000000');
    const [read] = f.standin.calls('conversations.history');
    expect(read?.params.oldest).toBe(slackTs(f.clock.now - 30 * day));
  });
});

describe("each method's ceiling", () => {
  it('asks for a page under the ceiling: 15 objects a history call until the listing is approved, 999 after', async () => {
    const f = await general({ tier: 'unlisted' });
    f.standin.channels.get('C0GENERAL')!.messages.push(...Array.from({ length: 20 }, (_, n) =>
      ({ ts: tsAt(connectedAt + 2 * 3_600_000 + n * 60_000), user: 'U0ADA', text: `note ${n}` })));
    const connector = f.connector();
    const at = request(f.clock.now);
    const listed = await connector.sync.historyPage(at, '0.000000', null);
    const page = await connector.sync.historyPage(at, '0.000000', listed.nextPageToken);
    expect(f.standin.calls('conversations.history')[0]?.params.limit).toBe('15');
    expect(f.quota.trace.find((entry) => entry.method === 'conversations.history')).toMatchObject({ objects: 15 });
    expect(page.nextPageToken).not.toBeNull();
    await expect(connector.sync.historyPage(at, '0.000000', page.nextPageToken)).rejects.toMatchObject({ code: 'rate_limited' });
    await f.close(); fixture = null;
    const listedFixture = await general({ tier: 'listed' });
    const after = listedFixture.connector();
    const start = await after.sync.historyPage(request(listedFixture.clock.now), '0.000000', null);
    await after.sync.historyPage(request(listedFixture.clock.now), '0.000000', start.nextPageToken);
    expect(listedFixture.standin.calls('conversations.history')[0]?.params.limit).toBe('999');
  });

  it("records Slack's Retry-After for the one method that answered 429, and the other methods go on", async () => {
    const f = await general();
    f.standin.limitNext('conversations.history', 30);
    const connector = f.connector();
    const at = request(f.clock.now);
    const listed = await connector.sync.historyPage(at, '0.000000', null);
    const refused = await connector.sync.historyPage(at, '0.000000', listed.nextPageToken).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SourceSyncFault);
    expect(refused).toMatchObject({ code: 'rate_limited', retryAt: f.clock.now + 30_000 });
    expect(f.quota.defers).toEqual([{ method: 'conversations.history', retryAt: f.clock.now + 30_000 }]);
    await expect(f.api.history('C0GENERAL', { oldest: slackTs(connectedAt), cursor: null, limit: 10 }))
      .rejects.toMatchObject({ code: 'rate_limited' });
    expect(await f.api.userInfo('U0ADA')).toMatchObject({ id: 'U0ADA', name: 'Ada' });
    expect((await f.api.channelInfo('C0GENERAL')).name).toBe('general');
    expect(f.quota.trace.filter((entry) => entry.outcome === 'deferred').map((entry) => entry.method))
      .toEqual(['conversations.history']);
  });
});

describe('the read of one channel-day', () => {
  it("reads the day's messages and its threads' replies and renders the document", async () => {
    const f = await general();
    const channel = f.standin.channels.get('C0GENERAL')!;
    const parent = channel.messages[1]!;
    parent.reply_count = 1;
    channel.replies[parent.ts] = [{ ts: tsAt(connectedAt + day + 7_200_000), user: 'U0ADA', text: 'Signed', thread_ts: parent.ts }];
    const result = await f.connector().sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03');
    expect(result.kind).toBe('document');
    if (result.kind !== 'document') return;
    expect(result.document.read.content.text).toBe('Ada 1:00 AM: Budget is final\n  Ada 2:00 AM: Signed');
    expect(result.document.read.ref).toMatchObject({ kind: 'slack', url: '/app/sources/slack/C0GENERAL:2026-11-03' });
    expect(result.document.cache).toEqual({ kind: 'cache', expiresAt: Date.parse('2026-11-03T00:00:00.000Z') + 90 * day,
      evidenceId: 'fixture-permission' });
    expect(f.standin.calls('conversations.replies')[0]?.params).toMatchObject({ ts: parent.ts, inclusive: 'true' });
  });

  it('renders a day the host holds from the events with no request', async () => {
    const f = await general();
    const result = await f.connector({ held: async () => ({ channel: { id: 'C0GENERAL', name: 'general', isPrivate: false,
      isMember: true, isArchived: false, isExtShared: false }, messages: [
      { ts: tsAt(connectedAt + day + 60_000), threadTs: null, user: 'U0ADA', botId: null, botName: null, subtype: null,
        text: 'Live from an event', editedTs: null, files: [], replyCount: 0 },
    ], replies: {} }) }).sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03');
    expect(result).toMatchObject({ kind: 'document', document: { read: { content: { text: 'Ada 12:01 AM: Live from an event' } } } });
    expect(f.standin.calls('conversations.history')).toEqual([]);
    expect(f.standin.calls('conversations.info')).toEqual([]);
  });

  it("keeps a day whose thread Slack does not find, without that thread's parent, and answers a day gone with its channel", async () => {
    const f = await general();
    f.standin.channels.get('C0GENERAL')!.messages.push({ ts: tsAt(connectedAt + day + 7_200_000), user: 'U0ADA',
      text: 'Removed while it was read', reply_count: 1 });
    f.standin.failNext('conversations.replies', { status: 200, body: { ok: false, error: 'thread_not_found' } });
    const result = await f.connector().sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03');
    expect(result).toMatchObject({ kind: 'document', document: { read: { content: { text: 'Ada 1:00 AM: Budget is final' } } } });
    expect(f.standin.calls('conversations.replies')).toHaveLength(1);
    f.standin.failNext('conversations.replies', { status: 200, body: { ok: false, error: 'channel_not_found' } });
    expect(await f.connector().sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03'))
      .toEqual({ kind: 'gone', id: 'C0GENERAL:2026-11-03' });
  });

  it("waits for a method's minute within the read's bound, and answers a retry past it", async () => {
    const f = await general({ tier: 'unlisted', windowMs: 60, realClock: true });
    f.standin.channels.get('C0GENERAL')!.messages.push(...Array.from({ length: 20 }, (_, n) =>
      ({ ts: tsAt(connectedAt + day + 4 * 3_600_000 + n * 60_000), user: 'U0ADA', text: `note ${n}` })));
    // The fixture's day is fixed and this clock is the real one, so the retained days, the permission and the window
    // reach back far enough to hold that day on any date the suite runs.
    const wide = { retainedDays: 36_500, permission: async () => ({ evidenceId: 'fixture-permission', retentionMs: 36_500 * day }) };
    const at = () => request(Date.now(), { policy: { ...basePolicy, windowMs: 36_500 * day } });
    const done = await f.connector(wide).sync.readSource(at(), 'C0GENERAL:2026-11-03');
    expect(done.kind).toBe('document');
    expect(f.standin.calls('conversations.history')).toHaveLength(2);
    const later = await f.connector({ ...wide, waitMs: 0 }).sync.readSource(at(), 'C0GENERAL:2026-11-03');
    expect(later).toMatchObject({ kind: 'retry', id: 'C0GENERAL:2026-11-03', reason: 'rate_limited' });
    await expect(slackWithin({ until: Date.now() + 1000, clock: Date.now }, async () => 'answered')).resolves.toBe('answered');
  });

  it("waits for a method's minute within the connector's bound in the original interface's read too", async () => {
    const f = await general({ tier: 'unlisted', windowMs: 60, realClock: true });
    f.standin.channels.get('C0GENERAL')!.messages.push(...Array.from({ length: 20 }, (_, n) =>
      ({ ts: tsAt(connectedAt + day + 4 * 3_600_000 + n * 60_000), user: 'U0ADA', text: `note ${n}` })));
    const read = await f.connector({ retainedDays: 36_500 }).read({ id: 'C0GENERAL:2026-11-03', title: '#general on Nov 3, 2026',
      size: null, version: null });
    expect(read).toMatchObject({ content: { text: expect.stringContaining('Budget is final') } });
    expect(read).toMatchObject({ content: { text: expect.stringContaining('note 19') } });
    expect(f.standin.calls('conversations.history')).toHaveLength(2);
  });

  it("ends a call whose host binding never answers once the call's signal aborts", async () => {
    const f = await general();
    const hung = () => {
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      return { entered, binding: (): Promise<never> => { reached(); return new Promise<never>(() => {}); } };
    };
    const permission = hung();
    const reading = new AbortController();
    const read = f.connector({ permission: permission.binding })
      .sync.readSource(request(f.clock.now, { signal: reading.signal }), 'C0GENERAL:2026-11-03');
    await permission.entered; reading.abort();
    await expect(read).rejects.toMatchObject({ code: 'cancelled' });
    const admits = hung();
    const walking = new AbortController();
    const page = f.connector({ admits: admits.binding }).sync.historyPage(request(f.clock.now, { signal: walking.signal }),
      '0.000000', null);
    await admits.entered; walking.abort();
    await expect(page).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('answers a day gone when its channel is gone, and a skip when the host has no permission to keep it', async () => {
    const f = await general();
    expect(await f.connector().sync.readSource(request(f.clock.now), 'C0MISSING:2026-11-03'))
      .toEqual({ kind: 'gone', id: 'C0MISSING:2026-11-03' });
    expect(await f.connector({ permission: async () => null }).sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03'))
      .toEqual({ kind: 'skipped', id: 'C0GENERAL:2026-11-03', reason: 'not_permitted' });
    expect(await f.connector().sync.readSource(request(f.clock.now, { policy: { ...basePolicy } }), 'C0GENERAL:2026-10-01'))
      .toEqual({ kind: 'gone', id: 'C0GENERAL:2026-10-01' });
  });
});

describe("the original interface's changes", () => {
  it('reports each selected day of a channel the set reads changed, since Slack lists no edit, reply or deletion by its time', async () => {
    const f = await general();
    const channel = f.standin.channels.get('C0GENERAL')!;
    const cursor = slackTs(connectedAt + 2 * day);
    const after = tsAt(connectedAt + 2 * day + 3_600_000);
    // After the cursor: a reply in the channel's first day's thread, sent to the thread alone; an edit of the second
    // day's message; and the deletion of a message the third day held. None of them is a message newer than the cursor.
    channel.messages[0]!.reply_count = 1;
    channel.replies[channel.messages[0]!.ts] = [{ ts: after, user: 'U0ADA', text: 'Agreed', thread_ts: channel.messages[0]!.ts }];
    channel.messages[1]!.edited = { user: 'U0ADA', ts: after };
    const changes = await f.connector().changesSince(cursor, { ids: ['C0GENERAL:2026-11-01', 'C0GENERAL:2026-11-02',
      'C0MISSING:2026-11-03', 'C0GENERAL:2026-11-03', 'C0GENERAL:2026-11-04', 'C0GENERAL:2026-11-06'] });
    expect(changes.changed.map((item) => [item.id, item.title])).toEqual([
      ['C0GENERAL:2026-11-02', '#general on Nov 2, 2026'], ['C0GENERAL:2026-11-03', '#general on Nov 3, 2026'],
      ['C0GENERAL:2026-11-04', '#general on Nov 4, 2026'],
    ]);
    expect(changes.gone).toEqual([{ id: 'C0MISSING:2026-11-03', reason: 'removed' }]);
    expect(changes.cursor).toBe(slackTs(f.clock.now));
    expect(f.standin.calls('conversations.history')).toEqual([]);
  });
});

describe("the reconcile's window pass", () => {
  it('reads every retained day again within a week, one slice a day, never before the read-from bound', () => {
    const from = connectedAt - 40 * day;
    const seen = new Set<string>();
    for (let n = 0; n < 7; n++) for (const date of slackWindowSlice(from, connectedAt + n * day, 90)) seen.add(date);
    for (let at = from; at <= connectedAt; at += day) expect(seen.has(new Date(at).toISOString().slice(0, 10))).toBe(true);
    expect([...seen].every((date) => Date.parse(`${date}T00:00:00.000Z`) >= from)).toBe(true);
    expect(slackWindowSlice(connectedAt, connectedAt - day, 90)).toEqual([]);
  });

  it("covers the host's retained days and none before them", () => {
    const from = connectedAt - 40 * day;
    const dates = (back: readonly number[]) => back.map((n) => new Date(connectedAt - n * day).toISOString().slice(0, 10));
    expect(slackWindowSlice(from, connectedAt, 30)).toEqual(dates([0, 7, 14, 21, 28]));
    expect(slackWindowSlice(from, connectedAt, 90)).toEqual(dates([0, 7, 14, 21, 28, 35]));
  });
});
