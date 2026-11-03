import { describe, expect, it, vi } from 'vitest';
import {
  SLACK_ENVELOPE_BYTES, SlackEnvelopeFault, enqueueSlackEvent, parseSlackEnvelope, slackEventSources, slackRetryOf,
  verifySlackSignature,
} from '../src/index.js';
import { SlackStandin } from './standin.js';

const scope = { tenantId: 'tenant-a', ownerId: 'owner-a', connectionId: 'connection-a' };

/** An `event_callback` envelope around one event. */
function callback(event: Record<string, unknown>, eventId = 'Ev0FIXTURE') {
  return { token: 'legacy', team_id: 'T0FIXTURE', api_app_id: 'A0FIXTURE', type: 'event_callback', event_id: eventId,
    event_time: 1_793_000_000, event: { event_ts: '1793000000.000900', ...event } };
}

describe('the events envelope', () => {
  it("answers Slack's url_verification challenge", () => {
    expect(parseSlackEnvelope(JSON.stringify({ token: 'legacy', challenge: 'fixture-challenge', type: 'url_verification' })))
      .toEqual({ kind: 'url_verification', challenge: 'fixture-challenge' });
  });

  it('parses a message event with its key, its workspace and its time, and names the day it changes', () => {
    const envelope = parseSlackEnvelope(JSON.stringify(callback({ type: 'message', channel: 'C0GENERAL',
      channel_type: 'channel', user: 'U0ADA', text: 'Budget is final', ts: '1793000000.000100' })));
    expect(envelope).toMatchObject({ kind: 'event_callback', teamId: 'T0FIXTURE', eventId: 'Ev0FIXTURE',
      eventTime: 1_793_000_000, eventTs: '1793000000.000900', type: 'message', subtype: null,
      event: { kind: 'message', channel: 'C0GENERAL', message: { ts: '1793000000.000100', user: 'U0ADA', text: 'Budget is final' } } });
    if (envelope.kind !== 'event_callback') throw new Error('unexpected_envelope');
    expect(slackEventSources(envelope.event)).toEqual(['C0GENERAL:2026-10-26']);
  });

  it("names a thread reply's parent day, an edit's message day and a deletion's day", () => {
    const parse = (event: Record<string, unknown>) => {
      const envelope = parseSlackEnvelope(JSON.stringify(callback(event)));
      if (envelope.kind !== 'event_callback') throw new Error('unexpected_envelope');
      return envelope.event;
    };
    const reply = parse({ type: 'message', channel: 'C0GENERAL', user: 'U0ADA', text: 'Agreed',
      ts: '1793000000.000200', thread_ts: '1792900000.000100' });
    expect(slackEventSources(reply)).toEqual(['C0GENERAL:2026-10-25']);
    const edit = parse({ type: 'message', subtype: 'message_changed', channel: 'C0GENERAL', ts: '1793000001.000000',
      message: { type: 'message', user: 'U0ADA', text: 'Budget is final, signed', ts: '1792900000.000100',
        edited: { user: 'U0ADA', ts: '1793000001.000000' } } });
    expect(edit).toMatchObject({ kind: 'message_changed', message: { ts: '1792900000.000100', editedTs: '1793000001.000000' } });
    expect(slackEventSources(edit)).toEqual(['C0GENERAL:2026-10-25']);
    const deleted = parse({ type: 'message', subtype: 'message_deleted', channel: 'C0GENERAL', ts: '1793000002.000000',
      deleted_ts: '1793000000.000300', previous_message: { ts: '1793000000.000300', thread_ts: '1792900000.000100' } });
    expect(deleted).toEqual({ kind: 'message_deleted', channel: 'C0GENERAL', deletedTs: '1793000000.000300',
      threadTs: '1792900000.000100' });
    expect(slackEventSources(deleted)).toEqual(['C0GENERAL:2026-10-25']);
  });

  it('keeps a file share and a bot post, takes a join notice as a notice that changes no day, and never a direct message', () => {
    const event = (body: Record<string, unknown>) => {
      const envelope = parseSlackEnvelope(JSON.stringify(callback(body)));
      if (envelope.kind !== 'event_callback') throw new Error('unexpected_envelope');
      return envelope.event;
    };
    expect(event({ type: 'message', subtype: 'file_share', channel: 'C0GENERAL', user: 'U0ADA', text: 'Plan attached',
      ts: '1793000000.000400', files: [{ name: 'plan.pdf', url_private: 'https://files.invalid/plan.pdf' }] }))
      .toMatchObject({ kind: 'message', message: { files: ['plan.pdf'] } });
    expect(event({ type: 'message', subtype: 'bot_message', channel: 'C0GENERAL', bot_id: 'B0STANDUP',
      username: 'Standup', text: 'Standup at 10', ts: '1793000000.000500' }))
      .toMatchObject({ kind: 'message', message: { botId: 'B0STANDUP', botName: 'Standup' } });
    const notice = event({ type: 'message', subtype: 'channel_join', channel: 'C0GENERAL', user: 'U0ADA',
      text: 'has joined', ts: '1793000000.000600' });
    expect(notice).toEqual({ kind: 'notice', channel: 'C0GENERAL', subtype: 'channel_join' });
    expect(slackEventSources(notice)).toEqual([]);
    const direct = event({ type: 'message', channel: 'D0DIRECT', channel_type: 'im', user: 'U0ADA', text: 'hi',
      ts: '1793000000.000700' });
    expect(direct).toEqual({ kind: 'other', type: 'message' });
  });

  it('parses the channel, membership and installation events the read follows', () => {
    const event = (body: Record<string, unknown>) => {
      const envelope = parseSlackEnvelope(JSON.stringify(callback(body)));
      if (envelope.kind !== 'event_callback') throw new Error('unexpected_envelope');
      return envelope.event;
    };
    expect(event({ type: 'member_joined_channel', channel: 'C0GENERAL', user: 'U0BOT', inviter: 'U0ADA' }))
      .toEqual({ kind: 'membership', type: 'member_joined_channel', channel: 'C0GENERAL', user: 'U0BOT', inviter: 'U0ADA' });
    expect(event({ type: 'channel_rename', channel: { id: 'C0GENERAL', name: 'all-hands', created: 1 } }))
      .toEqual({ kind: 'channel', type: 'channel_rename', channel: 'C0GENERAL', previousChannel: null, name: 'all-hands' });
    expect(event({ type: 'channel_id_changed', old_channel_id: 'G0PRIVATE', new_channel_id: 'C0SHARED' }))
      .toEqual({ kind: 'channel', type: 'channel_id_changed', channel: 'C0SHARED', previousChannel: 'G0PRIVATE', name: null });
    expect(event({ type: 'message', subtype: 'channel_convert_to_private', channel: 'C0GENERAL', ts: '1793000000.000800' }))
      .toEqual({ kind: 'channel', type: 'channel_convert_to_private', channel: 'C0GENERAL', previousChannel: null, name: null });
    expect(event({ type: 'app_uninstalled' })).toEqual({ kind: 'app', type: 'app_uninstalled', user: null });
    expect(event({ type: 'user_change', user: { id: 'U0INSTALLER', deleted: true } }))
      .toEqual({ kind: 'app', type: 'user_change', user: 'U0INSTALLER' });
  });

  it("parses Slack's rate-limit notice and refuses what Slack does not send", () => {
    expect(parseSlackEnvelope(JSON.stringify({ token: 'legacy', team_id: 'T0FIXTURE', minute_rate_limited: 1_793_000_000,
      api_app_id: 'A0FIXTURE', type: 'app_rate_limited' })))
      .toEqual({ kind: 'app_rate_limited', teamId: 'T0FIXTURE', minuteRateLimited: 1_793_000_000 });
    expect(() => parseSlackEnvelope('not json')).toThrow(SlackEnvelopeFault);
    expect(() => parseSlackEnvelope(JSON.stringify({ type: 'event_callback', team_id: 'T0FIXTURE' }))).toThrow('slack_envelope_invalid');
    expect(() => parseSlackEnvelope('x'.repeat(SLACK_ENVELOPE_BYTES + 1))).toThrow('slack_envelope_too_large');
  });

  it("tells Slack's retries by their headers", () => {
    expect(slackRetryOf({ 'X-Slack-Retry-Num': '2', 'X-Slack-Retry-Reason': 'http_timeout' }))
      .toEqual({ retryNum: 2, reason: 'http_timeout' });
    expect(slackRetryOf(new Headers())).toBeNull();
  });

  it('a signed message event, checked and parsed, queues its channel-day into the sync with the reason event', async () => {
    const secret = 'fixture-signing-secret'; const now = 1_793_000_000_000;
    const { rawBody, headers } = SlackStandin.signed(callback({ type: 'message', channel: 'C0GENERAL', user: 'U0ADA',
      text: 'Budget is final', ts: '1793000000.000100' }), secret, now / 1000);
    expect(verifySlackSignature({ headers, rawBody, signingSecret: secret, now })).toEqual({ valid: true });
    const intake = { enqueue: vi.fn(async () => ({ kind: 'queued' as const, queued: 1, opened: true })) };
    expect(await enqueueSlackEvent(intake, scope, parseSlackEnvelope(rawBody))).toEqual({ kind: 'queued', queued: 1, opened: true });
    expect(intake.enqueue).toHaveBeenCalledWith(scope, ['C0GENERAL:2026-10-26'], 'event');
    const notice = parseSlackEnvelope(JSON.stringify(callback({ type: 'member_left_channel', channel: 'C0GENERAL', user: 'U0ADA' })));
    expect(await enqueueSlackEvent(intake, scope, notice)).toBeNull();
    expect(intake.enqueue).toHaveBeenCalledTimes(1);
  });
});
