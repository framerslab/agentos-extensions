import { describe, expect, it } from 'vitest';
import {
  SLACK_DAY_MESSAGES, channelDayExpiry, mapChannelDay, parseSlackMessage, type SlackDayRender, type SlackMessage,
} from '../src/index.js';
import { day, tsAt } from './standin.js';

const start = Date.parse('2026-11-04T00:00:00.000Z');
const people = { U0ADA: 'Ada', U0GRACE: 'Grace' };

function message(raw: Record<string, unknown>): SlackMessage {
  const parsed = parseSlackMessage(raw);
  if (parsed === null) throw new Error('fixture_message_unparsed');
  return parsed;
}

function render(change: Partial<SlackDayRender> = {}): SlackDayRender {
  return { readFrom: start - day, retainedDays: 90, windowMs: 365 * day, ownBotIds: ['B0SAYSHERE'], tombstones: new Set(),
    sourceDetailUrl: '/app/sources/slack/C0GENERAL/2026-11-04', readAt: start + 3 * day,
    cache: { kind: 'cache', expiresAt: start + 30 * day, evidenceId: 'fixture-permission' }, ...change };
}

const parent = message({ ts: tsAt(start + 9 * 3_600_000 + 5 * 60_000), user: 'U0ADA',
  text: 'Budget for <#C0DESIGN|design> is final, <@U0GRACE> please check &lt;v2&gt;', reply_count: 2 });
const reply = message({ ts: tsAt(start + 2 * day), user: 'U0GRACE', text: 'Checked', thread_ts: parent.ts });
const edited = message({ ts: tsAt(start + 10 * 3_600_000), user: 'U0GRACE', text: 'Standup moved',
  edited: { user: 'U0GRACE', ts: tsAt(start + 11 * 3_600_000) } });
const original = message({ ts: edited.ts, user: 'U0GRACE', text: 'Standup at 10' });
const file = message({ ts: tsAt(start + 12 * 3_600_000), user: 'U0ADA', subtype: 'file_share', text: 'Plan',
  files: [{ name: 'plan.pdf' }] });
const bot = message({ ts: tsAt(start + 13 * 3_600_000), subtype: 'bot_message', bot_id: 'B0STANDUP', username: 'Standup',
  text: 'Standup report <https://example.invalid/r|report>' });
const own = message({ ts: tsAt(start + 14 * 3_600_000), subtype: 'bot_message', bot_id: 'B0SAYSHERE', username: 'SaysHere',
  text: 'Meeting notes' });
const deleted = message({ ts: tsAt(start + 15 * 3_600_000), user: 'U0ADA', text: 'Wrong channel' });

describe('the channel-day document', () => {
  it("renders a day's messages in time order, a thread's replies under their parent, edits applied and mentions resolved", () => {
    const document = mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04',
      messages: [bot, deleted, edited, parent, original, file, own], replies: { [parent.ts]: [reply] }, people },
    render({ tombstones: new Set([deleted.ts]) }));
    expect(document).not.toBeNull();
    const text = document!.read.content.text;
    expect(text).toBe([
      'Ada 9:05 AM: Budget for #design is final, @Grace please check <v2>',
      '  Grace 12:00 AM: Checked',
      'Grace 10:00 AM: Standup moved',
      'Ada 12:00 PM: Plan [file: plan.pdf]',
      'Standup 1:00 PM: Standup report report (https://example.invalid/r)',
    ].join('\n'));
    expect(document!.read.item).toEqual({ id: 'C0GENERAL:2026-11-04', title: '#general on Nov 4, 2026', size: text.length,
      version: reply.ts });
    expect(document!.read.ref).toMatchObject({ kind: 'slack', title: '#general on Nov 4, 2026',
      url: '/app/sources/slack/C0GENERAL/2026-11-04', version: reply.ts });
    expect(document!.messages.map((span) => text.slice(span.start, span.end).trim().split(':')[0]))
      .toEqual(['Ada 9', 'Grace 12', 'Grace 10', 'Ada 12', 'Standup 1']);
    expect(document!.messages.map((span) => span.messageId)).toEqual([parent.ts, reply.ts, edited.ts, file.ts, bot.ts]);
    expect(document!.metadata).toMatchObject({ channelId: 'C0GENERAL', day: '2026-11-04', messages: 5, complete: true });
    expect(document!.activityAt).toBe(start + 2 * day);
  });

  it("keeps each message the shorter of the host's retained days from its day and the connection's window", () => {
    expect(channelDayExpiry('2026-11-04', 90, 365 * day)).toBe(start + 90 * day);
    expect(channelDayExpiry('2026-11-04', 120, 365 * day)).toBe(start + 120 * day);
    expect(channelDayExpiry('2026-11-04', 90, 30 * day)).toBe(start + 30 * day);
    const document = mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: [parent],
      replies: {}, people }, render({ windowMs: 30 * day }));
    expect(document!.messages[0]!.windowExpiresAt).toBe(start + 30 * day);
    const shorter = mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: [parent],
      replies: {}, people }, render({ retainedDays: 30 }));
    expect(shorter!.messages[0]!.windowExpiresAt).toBe(start + 30 * day);
  });

  it('leaves out what comes before the read-from bound, and answers null for a day with nothing left', () => {
    expect(mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: [parent, edited],
      replies: {}, people }, render({ readFrom: start + day }))).toBeNull();
    expect(mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: [own],
      replies: {}, people }, render())).toBeNull();
  });

  it("dates a message no later than the read, and keeps a day past the store's bounds up to them", () => {
    const early = mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: [parent],
      replies: {}, people }, render({ readAt: start + 1000 }));
    expect(early!.messages[0]!.receivedAt).toBe(start + 1000);
    const many = Array.from({ length: SLACK_DAY_MESSAGES + 5 }, (_, n) =>
      message({ ts: tsAt(start + n * 60_000, n % 1000), user: 'U0ADA', text: `line ${n}` }));
    const full = mapChannelDay({ channelId: 'C0GENERAL', channelName: 'general', day: '2026-11-04', messages: many,
      replies: {}, people }, render());
    expect(full!.messages).toHaveLength(SLACK_DAY_MESSAGES);
    expect(full!.metadata).toMatchObject({ messages: SLACK_DAY_MESSAGES, complete: false });
  });
});
