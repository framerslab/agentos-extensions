/**
 * The Realtime Media Streams messages this provider sends and reads, by Zoom's event reference and data types. The app
 * sends integers for message and event types. What the pages leave open is a parameter with the documented value as
 * its default: the signature's encoding, the first sequence number, the samples' byte order.
 *
 * @module
 */
import { createHmac } from 'node:crypto';

/** `RTMS_MESSAGE_TYPE`, the values used here. */
export const MSG = {
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  EVENT_SUBSCRIPTION: 5,
  EVENT_UPDATE: 6,
  CLIENT_READY_ACK: 7,
  STREAM_STATE_UPDATE: 8,
  SESSION_STATE_UPDATE: 9,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_AUDIO: 14,
  STREAM_CLOSE_REQ: 21,
  STREAM_CLOSE_RESP: 22,
} as const;

/** `RTMS_EVENT_TYPE`, the values used here. */
export const EVENT = { FIRST_PACKET_TIMESTAMP: 1, ACTIVE_SPEAKER_CHANGE: 2, MEDIA_CONNECTION_INTERRUPTED: 7 } as const;

/** `RTMS_STREAM_STATE`. */
export const STREAM_STATE = { INACTIVE: 0, ACTIVE: 1, INTERRUPTED: 2, TERMINATING: 3, TERMINATED: 4, PAUSED: 5, RESUMED: 6 } as const;

/** `RTMS_SESSION_STATE`. */
export const SESSION_STATE = { INACTIVE: 0, INITIALIZE: 1, STARTED: 2, PAUSED: 3, RESUMED: 4, STOPPED: 5 } as const;

/** How the handshakes' signature is written: hex (the quickstart's form, the default) or base64. */
export type SignatureEncoding = 'hex' | 'base64';
/** The byte order of the 16-bit samples Zoom sends: little-endian (the default) or big-endian. */
export type PcmByteOrder = 'le' | 'be';

/** The handshakes' signature: the HMAC-SHA256 of `clientId,meetingUuid,streamId` under the client secret. */
export function rtmsSignature(input: { clientId: string; clientSecret: string; meetingUuid: string; streamId: string; encoding?: SignatureEncoding }): string {
  return createHmac('sha256', input.clientSecret).update(`${input.clientId},${input.meetingUuid},${input.streamId}`).digest(input.encoding ?? 'hex');
}

/** The signaling handshake (message type 1), with the sequence the pages say must start at 1. */
export function signalingHandshake(input: { meetingUuid: string; streamId: string; signature: string; sequence?: number }): Record<string, unknown> {
  return {
    msg_type: MSG.SIGNALING_HAND_SHAKE_REQ,
    protocol_version: 1,
    sequence: input.sequence ?? 1,
    meeting_uuid: input.meetingUuid,
    rtms_stream_id: input.streamId,
    signature: input.signature,
    // nothing captured before this connection exists is wanted
    buffer_data: false,
  };
}

/** Audio alone: raw, 16 kHz, mono, L16, one mixed stream, a packet every 20 milliseconds. */
export function mediaHandshake(input: { meetingUuid: string; streamId: string; signature: string }): Record<string, unknown> {
  return {
    msg_type: MSG.DATA_HAND_SHAKE_REQ,
    protocol_version: 1,
    sequence: 0,
    meeting_uuid: input.meetingUuid,
    rtms_stream_id: input.streamId,
    signature: input.signature,
    media_type: 1,
    media_params: { audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 20 } },
  };
}

/** The client-ready message (type 7), sent on the signaling connection once the media handshake is answered. */
export function clientReady(streamId: string): Record<string, unknown> {
  return { msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: streamId };
}

/** The answer (type 13) to a keep-alive request, carrying the request's own timestamp. */
export function keepAliveResponse(timestamp: number): Record<string, unknown> {
  return { msg_type: MSG.KEEP_ALIVE_RESP, timestamp };
}

/** The subscription (type 5) to the active speaker event. */
export function subscribeActiveSpeaker(): Record<string, unknown> {
  return { msg_type: MSG.EVENT_SUBSCRIPTION, events: [{ event_type: EVENT.ACTIVE_SPEAKER_CHANGE, subscribe: true }] };
}

/** The close request (type 21) for a stream. */
export function streamCloseRequest(streamId: string): Record<string, unknown> {
  return { msg_type: MSG.STREAM_CLOSE_REQ, rtms_stream_id: streamId };
}

/** A message from Zoom's side, read into the kinds this provider acts on. */
export type RtmsServerMessage =
  | { kind: 'signaling_handshake'; statusCode: number; audioUrl: string | undefined }
  | { kind: 'media_handshake'; statusCode: number; payloadEncrypted: boolean }
  | { kind: 'keep_alive'; timestamp: number }
  | { kind: 'audio'; data: string; timestamp: number }
  | { kind: 'speaker'; name: string; timestamp: number }
  | { kind: 'media_interrupted' }
  | { kind: 'stream_state'; state: number; reason: number | undefined }
  | { kind: 'session_state'; state: number; reason: number | undefined }
  | { kind: 'close_response'; statusCode: number }
  | { kind: 'other'; msgType: number };

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** Reads one of the server's text messages. Throws on a body that is not JSON or names no message type. */
export function readServerMessage(text: string): RtmsServerMessage {
  const message = obj(JSON.parse(text));
  const type = num(message.msg_type);
  if (type === undefined) throw new Error('a message without a type');
  switch (type) {
    case MSG.SIGNALING_HAND_SHAKE_RESP: {
      const urls = obj(obj(message.media_server).server_urls);
      return { kind: 'signaling_handshake', statusCode: num(message.status_code) ?? -1, audioUrl: str(urls.audio) ?? str(urls.all) };
    }
    case MSG.DATA_HAND_SHAKE_RESP:
      return { kind: 'media_handshake', statusCode: num(message.status_code) ?? -1, payloadEncrypted: message.payload_encrypted === true };
    case MSG.KEEP_ALIVE_REQ:
      return { kind: 'keep_alive', timestamp: num(message.timestamp) ?? 0 };
    case MSG.MEDIA_DATA_AUDIO: {
      const content = obj(message.content);
      const data = str(content.data);
      return data === undefined ? { kind: 'other', msgType: type } : { kind: 'audio', data, timestamp: num(content.timestamp) ?? 0 };
    }
    case MSG.EVENT_UPDATE: {
      const event = obj(message.event);
      if (event.event_type === EVENT.ACTIVE_SPEAKER_CHANGE) {
        const name = str(event.user_name);
        if (name !== undefined) return { kind: 'speaker', name, timestamp: num(event.timestamp) ?? 0 };
      }
      if (event.event_type === EVENT.MEDIA_CONNECTION_INTERRUPTED) return { kind: 'media_interrupted' };
      return { kind: 'other', msgType: type };
    }
    case MSG.STREAM_STATE_UPDATE:
      return { kind: 'stream_state', state: num(message.state) ?? -1, reason: num(message.reason) };
    case MSG.SESSION_STATE_UPDATE:
      // the reference's example names `stop_reason` and its table `reason`: either is read
      return { kind: 'session_state', state: num(message.state) ?? -1, reason: num(message.stop_reason) ?? num(message.reason) };
    case MSG.STREAM_CLOSE_RESP:
      return { kind: 'close_response', statusCode: num(message.status_code) ?? -1 };
    default:
      return { kind: 'other', msgType: type };
  }
}

/** Base64 of 16-bit samples as an array of them; an odd byte at the end is dropped. */
export function decodePcm16(base64: string, order: PcmByteOrder = 'le'): Int16Array {
  return pcm16Of(Buffer.from(base64, 'base64'), order);
}

/** Raw bytes of 16-bit samples as an array of them. */
export function pcm16Of(bytes: Buffer, order: PcmByteOrder = 'le'): Int16Array {
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = order === 'le' ? bytes.readInt16LE(i * 2) : bytes.readInt16BE(i * 2);
  return samples;
}
