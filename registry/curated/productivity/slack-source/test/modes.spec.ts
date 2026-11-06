import { afterEach, describe, expect, it } from 'vitest';
import { slackAdmission, type SlackChannel, type SlackSelectionMode } from '../src/index.js';
import { day, tsAt } from './standin.js';
import { basePolicy, connectedAt, openSlack, request, walk, type SlackFixture } from './fixture.js';

let fixture: SlackFixture | null = null;
afterEach(async () => { await fixture?.close(); fixture = null; });

/**
 * A workspace with every kind of channel: a public channel the bot is in, a public one it is not in, a private one it
 * was invited into, a private one it was not, a Slack Connect channel it is in and an archived one.
 */
async function workspace(): Promise<SlackFixture> {
  fixture = await openSlack();
  fixture.standin.people.set('U0ADA', { name: 'Ada', email: null });
  const message = (text: string) => [{ ts: tsAt(connectedAt + day + 3_600_000), user: 'U0ADA', text }];
  fixture.standin.channel({ id: 'C0GENERAL', name: 'general', messages: message('General') });
  fixture.standin.channel({ id: 'C0RANDOM', name: 'random', is_member: false, messages: message('Random') });
  fixture.standin.channel({ id: 'G0SECRET', name: 'secret', is_private: true, messages: message('Secret') });
  fixture.standin.channel({ id: 'G0HIDDEN', name: 'hidden', is_private: true, is_member: false, messages: message('Hidden') });
  fixture.standin.channel({ id: 'C0CONNECT', name: 'partner', is_ext_shared: true, messages: message('Partner') });
  fixture.standin.channel({ id: 'C0OLD', name: 'old', is_archived: true, messages: message('Old') });
  return fixture;
}

/** The channels a walk under a mode read, by their history requests, and the channels it joined. */
async function walkUnder(mode: SlackSelectionMode): Promise<{ read: string[]; joined: string[]; ids: readonly string[] }> {
  const f = await workspace();
  const result = await walk(f.connector(), request(f.clock.now, { policy: { ...basePolicy, selectionMode: mode } }), '0.000000');
  return {
    read: f.standin.calls('conversations.history').map((call) => call.params.channel!),
    joined: f.standin.calls('conversations.join').map((call) => call.params.channel!),
    ids: result.ids,
  };
}

describe('the three channel sets', () => {
  it('invited: reads the public and private channels the bot was invited into and joins nothing', async () => {
    expect(await walkUnder('invited')).toEqual({ read: ['C0GENERAL', 'G0SECRET'], joined: [],
      ids: ['C0GENERAL:2026-11-03', 'G0SECRET:2026-11-03'] });
  });

  it('public: joins every public channel and reads it, and reads no private channel even when invited', async () => {
    expect(await walkUnder('public')).toEqual({ read: ['C0GENERAL', 'C0RANDOM'], joined: ['C0RANDOM'],
      ids: ['C0GENERAL:2026-11-03', 'C0RANDOM:2026-11-03'] });
    expect(fixture!.standin.calls('conversations.list')[0]?.params.types).toBe('public_channel');
  });

  it('all: joins every public channel and reads the private channels the bot was invited into', async () => {
    expect(await walkUnder('all')).toEqual({ read: ['C0GENERAL', 'C0RANDOM', 'G0SECRET'], joined: ['C0RANDOM'],
      ids: ['C0GENERAL:2026-11-03', 'C0RANDOM:2026-11-03', 'G0SECRET:2026-11-03'] });
  });

  it('never reads a Slack Connect channel, under any set, nor a day of one the host queued', async () => {
    for (const mode of ['invited', 'public', 'all'] as const) {
      const f = await workspace();
      await walk(f.connector(), request(f.clock.now, { policy: { ...basePolicy, selectionMode: mode } }), '0.000000');
      const read = await f.connector().sync.readSource(request(f.clock.now, { policy: { ...basePolicy, selectionMode: mode } }),
        'C0CONNECT:2026-11-03');
      expect(read).toEqual({ kind: 'gone', id: 'C0CONNECT:2026-11-03' });
      expect(f.standin.calls('conversations.history').some((call) => call.params.channel === 'C0CONNECT')).toBe(false);
      expect(f.standin.calls('conversations.join').some((call) => call.params.channel === 'C0CONNECT')).toBe(false);
      await f.close(); fixture = null;
    }
  });

  it("leaves a channel the host's own record keeps out, such as one a wider set joined earlier", async () => {
    const f = await workspace();
    const connector = f.connector({ admits: async (channel) => channel.id !== 'C0GENERAL' });
    const result = await walk(connector, request(f.clock.now), '0.000000');
    expect(result.ids).toEqual(['G0SECRET:2026-11-03']);
    expect(await connector.sync.readSource(request(f.clock.now), 'C0GENERAL:2026-11-03'))
      .toEqual({ kind: 'gone', id: 'C0GENERAL:2026-11-03' });
  });

  it("renders a day the host holds only for a channel the set and the host admit, by the host's record of the channel", async () => {
    const f = await workspace();
    const record = (change: Partial<SlackChannel>): SlackChannel => ({ id: 'G0SECRET', name: 'secret', isPrivate: true,
      isMember: true, isArchived: false, isExtShared: false, ...change });
    const host = (channel: SlackChannel) => ({ reconciled: async () => {}, held: async () => ({ channel, replies: {}, messages: [
      { ts: tsAt(connectedAt + day + 60_000), threadTs: null, user: 'U0ADA', botId: null, botName: null, subtype: null,
        text: 'Held from an event', editedTs: null, files: [], replyCount: 0 },
    ] }) });
    const under = (mode: SlackSelectionMode) => request(f.clock.now, { policy: { ...basePolicy, selectionMode: mode } });
    expect(await f.connector(host(record({}))).sync.readSource(under('public'), 'G0SECRET:2026-11-03'))
      .toEqual({ kind: 'gone', id: 'G0SECRET:2026-11-03' });
    expect(await f.connector(host(record({}))).sync.readSource(under('invited'), 'G0SECRET:2026-11-03'))
      .toMatchObject({ kind: 'document', document: { read: { item: { title: '#secret on Nov 3, 2026' } } } });
    for (const mode of ['invited', 'public', 'all'] as const) {
      const partner = record({ id: 'C0CONNECT', name: 'partner', isPrivate: false, isExtShared: true });
      expect(await f.connector(host(partner)).sync.readSource(under(mode), 'C0CONNECT:2026-11-03'))
        .toEqual({ kind: 'gone', id: 'C0CONNECT:2026-11-03' });
    }
    expect(await f.connector({ ...host(record({})), admits: async () => false }).sync.readSource(under('all'), 'G0SECRET:2026-11-03'))
      .toEqual({ kind: 'gone', id: 'G0SECRET:2026-11-03' });
    await expect(f.connector(host(record({ id: 'G0HIDDEN', name: 'hidden' }))).sync.readSource(under('invited'),
      'G0SECRET:2026-11-03')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.standin.calls('conversations.info')).toEqual([]);
    expect(f.standin.calls('conversations.history')).toEqual([]);
  });

  it('answers what each set does with each kind of channel', () => {
    const channel = (change: Partial<SlackChannel>): SlackChannel => ({ id: 'C0X', name: 'x', isPrivate: false,
      isMember: true, isArchived: false, isExtShared: false, ...change });
    const kinds = [channel({}), channel({ isMember: false }), channel({ isPrivate: true }),
      channel({ isPrivate: true, isMember: false }), channel({ isExtShared: true }), channel({ isArchived: true })];
    expect(kinds.map((entry) => slackAdmission(entry, 'invited'))).toEqual(['read', null, 'read', null, null, null]);
    expect(kinds.map((entry) => slackAdmission(entry, 'public'))).toEqual(['read', 'join', null, null, null, null]);
    expect(kinds.map((entry) => slackAdmission(entry, 'all'))).toEqual(['read', 'join', 'read', null, null, null]);
  });

  it("reads an item of the original interface by the set its channel was listed under, not the connector's default", async () => {
    const f = await workspace();
    const connector = f.connector({ mode: 'public' });
    const listed = await connector.list({ ids: ['G0SECRET:2026-11-03'], mode: 'invited' });
    expect(listed.items.map((item) => item.id)).toEqual(['G0SECRET:2026-11-03']);
    expect(await connector.read(listed.items[0]!)).toMatchObject({ content: { text: 'Ada 1:00 AM: Secret' } });
    expect(await f.connector({ mode: 'public' }).read(listed.items[0]!)).toEqual({ id: 'G0SECRET:2026-11-03', reason: 'no_access' });
  });
});
