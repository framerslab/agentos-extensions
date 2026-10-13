import { describe, it, expect } from 'vitest';
import { ChannelMessage, reportEventId } from '../src/protocol.js';

const job = {
  type: 'job',
  runId: 'r1',
  platform: 'google_meet',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Notes',
  notice: { text: 'A notetaker is in this call and records nothing. Type "stop taking notes" in the chat to make it leave.', version: '1', lateArrivalText: 'A notetaker is in this call: "stop taking notes" makes it leave.' },
  stopPhrase: 'stop taking notes',
  limits: { waitingRoomMs: 600_000, aloneMs: 300_000, totalMs: 14_400_000 },
  livekit: { url: 'wss://livekit.example.test', token: 'not-a-real-token', identity: 'bot' },
};

describe('the command channel protocol', () => {
  it('parses a job, a command, an ack and a report', () => {
    expect(ChannelMessage.parse(job)).toEqual(job);
    const command = { type: 'command', id: 'c1', name: 'postChat', text: 'Leaving now.' };
    expect(ChannelMessage.parse(command)).toEqual(command);
    const ack = { type: 'ack', id: 'c1', ok: true };
    expect(ChannelMessage.parse(ack)).toEqual(ack);
    const report = { type: 'report', seq: 3, event: 'notice_posted', at: 1_700_000_000_000 };
    expect(ChannelMessage.parse(report)).toEqual(report);
  });

  it('refuses a report with an unknown event', () => {
    expect(ChannelMessage.safeParse({ type: 'report', seq: 4, event: 'recording_started', at: 1 }).success).toBe(false);
  });

  it('gives a report a stable event id from its run, sequence number and event', () => {
    expect(reportEventId('r1', 7, 'chat_message')).toBe('browser:r1:7:chat_message');
    expect(reportEventId('r1', 7, 'chat_message')).toBe(reportEventId('r1', 7, 'chat_message'));
    expect(reportEventId('r1', 8, 'chat_message')).not.toBe(reportEventId('r1', 7, 'chat_message'));
  });
});
