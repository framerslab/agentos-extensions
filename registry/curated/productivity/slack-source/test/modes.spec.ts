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

  it('answers what each set does with each kind of channel', () => {
    const channel = (change: Partial<SlackChannel>): SlackChannel => ({ id: 'C0X', name: 'x', isPrivate: false,
      isMember: true, isArchived: false, isExtShared: false, ...change });
    const kinds = [channel({}), channel({ isMember: false }), channel({ isPrivate: true }),
      channel({ isPrivate: true, isMember: false }), channel({ isExtShared: true }), channel({ isArchived: true })];
    expect(kinds.map((entry) => slackAdmission(entry, 'invited'))).toEqual(['read', null, 'read', null, null, null]);
    expect(kinds.map((entry) => slackAdmission(entry, 'public'))).toEqual(['read', 'join', null, null, null, null]);
    expect(kinds.map((entry) => slackAdmission(entry, 'all'))).toEqual(['read', 'join', 'read', null, null, null]);
  });
});
