import { describe, it, expect } from 'vitest';
import { clientReady, decodePcm16, keepAliveResponse, mediaHandshake, readMediaFrame, readServerMessage, rtmsSignature, signalingHandshake, streamCloseRequest, subscribeActiveSpeaker } from '../src/rtms/messages.js';

const ids = { clientId: 'client-id-1', clientSecret: 'not-a-real-secret', meetingUuid: 'm-uuid', streamId: 's-1' };

describe("the stream's messages", () => {
  it('signs clientId,meetingUuid,streamId with the client secret, in hex or in base64', () => {
    expect(rtmsSignature(ids)).toBe('2ff063a1c178fa6ca25fdf8b16463a511b4c41a0f3ac8b92a0a636672642ceaa');
    expect(rtmsSignature({ ...ids, encoding: 'base64' })).toBe('L/BjocF4+myiX9+LFkY6URtMQaDzrIuSoKY2ZyZCzqo=');
  });
  it('builds the two handshakes as the event reference writes them', () => {
    expect(signalingHandshake({ meetingUuid: 'm-uuid', streamId: 's-1', signature: 'sig' })).toEqual({ msg_type: 1, protocol_version: 1, sequence: 1, meeting_uuid: 'm-uuid', rtms_stream_id: 's-1', signature: 'sig', buffer_data: false });
    expect(signalingHandshake({ meetingUuid: 'm-uuid', streamId: 's-1', signature: 'sig', sequence: 0 }).sequence).toBe(0);
    expect(mediaHandshake({ meetingUuid: 'm-uuid', streamId: 's-1', signature: 'sig' })).toEqual({
      msg_type: 3, protocol_version: 1, sequence: 0, meeting_uuid: 'm-uuid', rtms_stream_id: 's-1', signature: 'sig', media_type: 1, payload_encryption: false,
      media_params: { audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 20 } },
    });
    expect(clientReady('s-1')).toEqual({ msg_type: 7, rtms_stream_id: 's-1' });
    expect(keepAliveResponse(1727384349123)).toEqual({ msg_type: 13, timestamp: 1727384349123 });
    expect(subscribeActiveSpeaker()).toEqual({ msg_type: 5, events: [{ event_type: 2, subscribe: true }] });
    expect(streamCloseRequest('s-1')).toEqual({ msg_type: 21, rtms_stream_id: 's-1' });
  });
  it("reads the server's messages from the event reference's own examples", () => {
    expect(readServerMessage('{"msg_type":2,"protocol_version":1,"sequence":0,"status_code":0,"reason":"","media_server":{"server_urls":{"audio":"wss://127.0.0.0:443","video":"wss://127.0.0.1:443","transcript":"wss://127.0.0.2:443","all":"wss://127.0.0.3:443"}}}')).toEqual({ kind: 'signaling_handshake', statusCode: 0, audioUrl: 'wss://127.0.0.0:443' });
    expect(readServerMessage('{"msg_type":2,"status_code":0,"media_server":{"server_urls":{"all":"wss://127.0.0.3:443"}}}')).toMatchObject({ audioUrl: 'wss://127.0.0.3:443' });
    expect(readServerMessage('{"msg_type":2,"status_code":3,"reason":"invalid signature"}')).toEqual({ kind: 'signaling_handshake', statusCode: 3, audioUrl: undefined });
    expect(readServerMessage('{"msg_type":4,"protocol_version":1,"status_code":0,"reason":"","sequence":0,"payload_encrypted":true,"media_params":{"audio":{"content_type":2,"sample_rate":1,"channel":1,"codec":1,"data_opt":1,"send_rate":100}}}')).toEqual({ kind: 'media_handshake', statusCode: 0, payloadEncrypted: true });
    expect(readServerMessage('{"msg_type":12,"timestamp":1727384349123}')).toEqual({ kind: 'keep_alive', timestamp: 1727384349123 });
    expect(readServerMessage('{"msg_type":14,"content":{"user_id":0,"data":"AAABAP///38AgA==","length":10,"timestamp":1738392033699}}')).toEqual({ kind: 'audio', data: 'AAABAP///38AgA==', timestamp: 1738392033699 });
    expect(readServerMessage('{"msg_type":6,"event":{"event_type":2,"timestamp":1727384349123,"user_id":22334455,"user_name":"John Smith"}}')).toEqual({ kind: 'speaker', name: 'John Smith', timestamp: 1727384349123 });
    expect(readServerMessage('{"msg_type":6,"event":{"event_type":7,"timestamp":1}}')).toEqual({ kind: 'media_interrupted' });
    expect(readServerMessage('{"msg_type":6,"event":{"event_type":1,"timestamp":1727384349123}}')).toEqual({ kind: 'other', msgType: 6 });
    expect(readServerMessage('{"msg_type":8,"state":4,"reason":1,"timestamp":1727384349123}')).toEqual({ kind: 'stream_state', state: 4, reason: 1 });
    expect(readServerMessage('{"msg_type":9,"state":5,"stop_reason":6,"timestamp":1,"rtms_session_id":"x"}')).toEqual({ kind: 'session_state', state: 5, reason: 6 });
    expect(readServerMessage('{"msg_type":9,"state":5,"reason":2,"timestamp":1,"rtms_session_id":"x"}')).toEqual({ kind: 'session_state', state: 5, reason: 2 });
    expect(readServerMessage('{"msg_type":22,"rtms_stream_id":"x","status_code":0,"reason":"OK","timestamp":1}')).toEqual({ kind: 'close_response', statusCode: 0 });
    expect(readServerMessage('{"msg_type":17,"content":{"data":"words"}}')).toEqual({ kind: 'other', msgType: 17 });
    expect(() => readServerMessage('not json')).toThrow();
    expect(() => readServerMessage('{"no":"type"}')).toThrow();
  });
  it("reads a media frame as a message whatever its kind, a binary message with space before its brace too, and samples or no message as none", () => {
    const keepAlive = '{"msg_type":12,"timestamp":1727384349123}';
    expect(readMediaFrame(Buffer.from(keepAlive), false)).toEqual({ kind: 'keep_alive', timestamp: 1727384349123 });
    expect(readMediaFrame(Buffer.from(keepAlive), true)).toEqual({ kind: 'keep_alive', timestamp: 1727384349123 });
    expect(readMediaFrame(Buffer.from(`\n  \t\r${keepAlive}\n`), true)).toEqual({ kind: 'keep_alive', timestamp: 1727384349123 });
    expect(readMediaFrame(Buffer.from(` ${keepAlive}`), false)).toEqual({ kind: 'keep_alive', timestamp: 1727384349123 });
    expect(readMediaFrame(Buffer.from([0x00, 0x00, 0x01, 0x00, 0xff, 0xff]), true)).toBeUndefined();
    expect(readMediaFrame(Buffer.from([0x20, 0x7b, 0x00, 0x7d]), true)).toBeUndefined(); // bytes that begin like a message and are not one
    expect(readMediaFrame(Buffer.alloc(0), true)).toBeUndefined();
    expect(readMediaFrame(Buffer.from('not json'), false)).toBeUndefined();
    expect(readMediaFrame(Buffer.from('{"no":"type"}'), false)).toBeUndefined();
  });

  it('decodes 16-bit samples in either byte order', () => {
    expect([...decodePcm16('AAABAP///38AgA==')]).toEqual([0, 1, -1, 32767, -32768]);
    expect([...decodePcm16('AAABAP///38AgA==', 'be')]).toEqual([0, 256, -1, -129, 128]);
    expect(decodePcm16('AAAB').length).toBe(1); // an odd byte at the end is dropped
  });
});
