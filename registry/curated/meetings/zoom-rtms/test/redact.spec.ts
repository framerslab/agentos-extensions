import { describe, it, expect } from 'vitest';
import { FIXTURE_IDS, redactCapture, type RawCapture } from '../src/capture/redact.js';

const audio = (timestamp: number, userId = 0, userName?: string) => JSON.stringify({ msg_type: 14, content: { user_id: userId, ...(userName === undefined ? {} : { user_name: userName }), data: 'AAABAP///38AgA==', length: 10, timestamp } });

const raw: RawCapture = {
  protocol: { signatureEncoding: 'hex', signalingSequence: 1, pcmByteOrder: 'le' },
  webhooks: [
    { ms: 0, body: JSON.stringify({ event: 'meeting.rtms_started', event_ts: 1760000000000, payload: { meeting_uuid: 'aBcD+real/uuid==', operator_id: 'realOperatorId99', rtms_stream_id: 'realstream0123456789', meeting_id: 81234567890, account_id: 'realAccountId77', is_original_host: true, server_urls: 'wss://rtms-sjc1.zoom.us/signaling?token=secret-token' } }) },
    { ms: 41_000, body: JSON.stringify({ event: 'meeting.rtms_stopped', event_ts: 1760000041000, payload: { meeting_uuid: 'aBcD+real/uuid==', rtms_stream_id: 'realstream0123456789', stop_reason: 20 } }) },
  ],
  signaling: [
    { ms: 120, binary: false, text: JSON.stringify({ msg_type: 2, protocol_version: 1, sequence: 0, status_code: 0, reason: '', media_server: { server_urls: { audio: 'wss://rtms-media-7.zoom.us:443/a?x=secret', all: 'wss://rtms-media-7.zoom.us:443/all?x=secret' } } }) },
    { ms: 400, binary: false, text: JSON.stringify({ msg_type: 6, event: { event_type: 1, timestamp: 1760000000400 } }) },
    { ms: 900, binary: false, text: JSON.stringify({ msg_type: 6, event: { event_type: 2, timestamp: 1760000000900, user_id: 16778240, user_name: 'Raw label alpha' } }) },
    { ms: 1_900, binary: false, text: JSON.stringify({ msg_type: 6, event: { event_type: 2, timestamp: 1760000001900, user_id: 16779264, user_name: 'Raw label beta' } }) },
    { ms: 2_900, binary: false, text: JSON.stringify({ msg_type: 6, event: { event_type: 2, timestamp: 1760000002900, user_id: 16778240, user_name: 'Raw label alpha' } }) },
    { ms: 3_000, binary: false, text: JSON.stringify({ msg_type: 6, event: { event_type: 3, timestamp: 1760000003000, participants: [{ user_id: 16779264, user_name: 'Raw label beta' }] } }) },
    { ms: 10_000, binary: false, text: JSON.stringify({ msg_type: 12, timestamp: 1760000010000 }) },
    { ms: 39_000, binary: false, text: JSON.stringify({ msg_type: 9, state: 5, stop_reason: 20, timestamp: 1760000039000, rtms_session_id: 'realSessionId55' }) },
    { ms: 39_100, binary: false, text: JSON.stringify({ msg_type: 8, state: 4, reason: 20, timestamp: 1760000039100 }) },
    { ms: 39_200, binary: false, text: JSON.stringify({ msg_type: 22, rtms_stream_id: 'realstream0123456789', status_code: 0, reason: 'OK', timestamp: 1760000039200 }) },
    { ms: 39_300, binary: false, text: JSON.stringify({ msg_type: 99, email: 'user@example.test', note: 'a shape nobody documented' }) },
    { ms: 39_400, binary: false, text: 'not json at all, with Raw label alpha in it' },
  ],
  media: [
    { ms: 300, binary: false, text: JSON.stringify({ msg_type: 4, protocol_version: 1, status_code: 0, reason: '', sequence: 0, payload_encrypted: false, media_params: { audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 20 } } }) },
    { ms: 500, binary: false, text: audio(1760000000500) },
    { ms: 520, binary: false, text: audio(1760000000520, 16778240, 'Raw label alpha') },
    { ms: 540, binary: false, text: audio(1760000000540) },
    { ms: 560, binary: true, base64: 'AAABAP///38AgA==' },
  ],
};

describe('redactCapture', () => {
  const fixture = redactCapture(raw, { maxAudioPackets: 3 });
  const text = JSON.stringify(fixture);

  it('leaves no name, identifier, address or time of the meeting in the fixture', () => {
    for (const secret of ['Sender', 'Raw label alpha', 'Raw label beta', 'Raw label', 'aBcD+real/uuid==', 'realOperatorId99', 'realstream0123456789', 'realAccountId77', 'realSessionId55', '81234567890', 'zoom.us', 'secret', 'user@example.test', '16778240', '16779264', '17600000']) {
      expect(text, secret).not.toContain(secret);
    }
  });
  it('gives the stream fixed ids and the local server\'s addresses', () => {
    expect(fixture.webhooks[0]).toEqual({ ms: 0, event: 'meeting.rtms_started', event_ts: 1_700_000_000_000, payload: { meeting_uuid: FIXTURE_IDS.meetingUuid, operator_id: FIXTURE_IDS.operatorId, rtms_stream_id: FIXTURE_IDS.streamId, meeting_id: FIXTURE_IDS.meetingId, account_id: FIXTURE_IDS.accountId, is_original_host: true, server_urls: 'wss://fake-rtms.test/signaling' } });
    expect(fixture.webhooks[1]).toMatchObject({ event: 'meeting.rtms_stopped', event_ts: 1_700_000_041_000, payload: { stop_reason: 20, rtms_stream_id: FIXTURE_IDS.streamId } });
    expect(fixture.signaling[0].message).toMatchObject({ msg_type: 2, status_code: 0, media_server: { server_urls: { audio: 'wss://fake-rtms.test/media', all: 'wss://fake-rtms.test/media' } } });
  });
  it('names speakers by the order they first spoke, the same person the same name', () => {
    const speakers = fixture.signaling.map((entry) => entry.message.event as { event_type?: number; user_name?: string; user_id?: number } | undefined).filter((event) => event?.event_type === 2);
    expect(speakers.map((event) => event?.user_name)).toEqual(['Speaker A', 'Speaker B', 'Speaker A']);
    expect(speakers.map((event) => event?.user_id)).toEqual([1001, 1002, 1001]);
    const joined = fixture.signaling.find((entry) => (entry.message.event as { event_type?: number } | undefined)?.event_type === 3);
    expect(joined?.message.event).toMatchObject({ participants: [{ user_id: 1002, user_name: 'Speaker B' }] });
  });
  it('moves every timestamp by one offset, so the gaps stand', () => {
    const keepAlive = fixture.signaling.find((entry) => entry.message.msg_type === 12);
    expect(keepAlive?.message.timestamp).toBe(1_700_000_010_000);
    const first = fixture.media.find((entry) => 'message' in entry && entry.message.msg_type === 14);
    expect(first && 'message' in first ? (first.message.content as { timestamp: number }).timestamp : 0).toBe(1_700_000_000_500);
  });
  it('keeps the states and reasons of the end, and nothing of a message it does not know', () => {
    expect(fixture.signaling.find((entry) => entry.message.msg_type === 9)?.message).toEqual({ msg_type: 9, state: 5, stop_reason: 20, timestamp: 1_700_000_039_000, rtms_session_id: FIXTURE_IDS.sessionId });
    expect(fixture.signaling.find((entry) => entry.message.msg_type === 8)?.message).toEqual({ msg_type: 8, state: 4, reason: 20, timestamp: 1_700_000_039_100 });
    expect(fixture.signaling.find((entry) => entry.message.msg_type === 22)?.message).toEqual({ msg_type: 22, rtms_stream_id: FIXTURE_IDS.streamId, status_code: 0, reason: '', timestamp: 1_700_000_039_200 });
    expect(fixture.signaling.find((entry) => entry.message.msg_type === 99)?.message).toEqual({ msg_type: 99 });
    expect(fixture.signaling.length).toBe(raw.signaling.length - 1); // the line that was not JSON is dropped
  });
  it('keeps the first audio packets alone, each as it came, and can silence them', () => {
    const packets = fixture.media.filter((entry) => !('message' in entry) || entry.message.msg_type === 14);
    expect(packets.length).toBe(3);
    expect(packets[0]).toMatchObject({ message: { msg_type: 14, content: { user_id: 0, data: 'AAABAP///38AgA==', length: 10 } } });
    expect(packets[1]).toMatchObject({ message: { content: { user_id: 1001, user_name: 'Speaker A' } } });
    const silent = redactCapture(raw, { silenceAudio: true });
    const quiet = silent.media.filter((entry) => 'message' in entry && entry.message.msg_type === 14) as Array<{ message: { content: { data: string } } }>;
    expect(quiet.every((entry) => Buffer.from(entry.message.content.data, 'base64').every((byte) => byte === 0))).toBe(true);
    expect(Buffer.from(quiet[0].message.content.data, 'base64').length).toBe(10);
    const binary = silent.media.find((entry) => 'binaryBase64' in entry) as { binaryBase64: string };
    expect(Buffer.from(binary.binaryBase64, 'base64').every((byte) => byte === 0)).toBe(true);
  });
  it('records how the stream was read', () => {
    expect(fixture.protocol).toEqual({ signatureEncoding: 'hex', signalingSequence: 1, pcmByteOrder: 'le' });
  });
});
