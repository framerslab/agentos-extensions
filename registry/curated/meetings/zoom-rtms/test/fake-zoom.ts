import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { rtmsSignature } from '../src/rtms/messages.js';

/**
 * Waits until a check holds, or fails after the timeout. The bound is wide, since a wait ends the moment its check
 * holds and only a failure pays it: the release workflow runs every package's tests at once, and under that load the
 * fake's handshake took more than three seconds (the Release run of 21 October 2026 on d6bb62ec).
 */
export async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface FakeRtmsIds {
  clientId: string;
  clientSecret: string;
  meetingUuid: string;
  streamId: string;
}

export const FAKE_IDS: FakeRtmsIds = { clientId: 'client-id-1', clientSecret: 'not-a-real-secret', meetingUuid: 'm-uuid', streamId: 's-1' };

/** Zoom's side of one stream on the loopback: the signaling connection at `/signaling`, the media connection at `/media`. */
export class FakeRtms {
  readonly signalingReceived: Array<Record<string, unknown>> = [];
  readonly mediaReceived: Array<Record<string, unknown>> = [];
  signalingConnections = 0;
  mediaConnections = 0;
  /** The status the next signaling handshake is answered with, whatever its signature. */
  refuseSignalingWith: number | undefined;
  /** New connections are closed at once: Zoom is gone. */
  refuseConnections = false;
  /** The code and reason new connections are closed with, when they are refused. */
  refuseConnectionsWith: { code: number; reason: string } | undefined;
  /** The status the media handshakes are answered with. */
  refuseMediaWith: number | undefined;
  withholdSignalingHandshake = false;
  withholdMediaHandshake = false;
  /** Each handshake is answered this long after it arrives: a slow Zoom, or a loaded runner. */
  readonly handshakeDelayMs = { signaling: 0, media: 0 };
  closeStatus = 0;
  closeWithoutResponse = false;
  port = 0;
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private signaling: WebSocket | undefined;
  private media: WebSocket | undefined;

  constructor(private readonly ids: FakeRtmsIds = FAKE_IDS) {}

  /** What a started event would carry. */
  get serverUrls(): string {
    return 'wss://fake-rtms.test/signaling';
  }

  /** The `connect` a stream is given: the fake's names, reached on the loopback. */
  readonly connect = (url: string): WebSocket => new WebSocket(url.replace('wss://fake-rtms.test', `ws://127.0.0.1:${this.port}`));

  async start(): Promise<void> {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (socket, request) => {
      if (this.refuseConnections) {
        if (this.refuseConnectionsWith === undefined) socket.close();
        else socket.close(this.refuseConnectionsWith.code, this.refuseConnectionsWith.reason);
        return;
      }
      if (request.url === '/signaling') this.onSignaling(socket);
      else this.onMedia(socket);
    });
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const client of this.wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => this.http?.close(() => resolve()) ?? resolve());
  }

  private onSignaling(socket: WebSocket): void {
    this.signalingConnections += 1;
    this.signaling = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      this.signalingReceived.push(message);
      if (message.msg_type === 1) {
        if (this.withholdSignalingHandshake) return;
        const good = message.signature === rtmsSignature(this.ids) && message.meeting_uuid === this.ids.meetingUuid && message.rtms_stream_id === this.ids.streamId;
        const status = this.refuseSignalingWith ?? (good ? 0 : 3);
        this.answer(socket, this.handshakeDelayMs.signaling, JSON.stringify({ msg_type: 2, protocol_version: 1, sequence: 0, status_code: status, reason: status === 0 ? '' : 'refused', media_server: { server_urls: { audio: 'wss://fake-rtms.test/media', all: 'wss://fake-rtms.test/media' } } }));
      }
      if (message.msg_type === 21) {
        if (!this.closeWithoutResponse) socket.send(JSON.stringify({ msg_type: 22, rtms_stream_id: message.rtms_stream_id, status_code: this.closeStatus, reason: '', timestamp: Date.now() }));
        setTimeout(() => {
          socket.close();
          this.media?.close();
        }, 5);
      }
    });
  }

  private onMedia(socket: WebSocket): void {
    this.mediaConnections += 1;
    this.media = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      this.mediaReceived.push(message);
      if (message.msg_type === 3 && !this.withholdMediaHandshake) this.answer(socket, this.handshakeDelayMs.media, JSON.stringify({ msg_type: 4, protocol_version: 1, status_code: this.refuseMediaWith ?? 0, reason: '', sequence: 0, payload_encrypted: false, media_params: message.media_params }));
    });
  }

  /** Sends an answer at once, or after the delay to a connection still open then: a late answer to one the client dropped goes nowhere. */
  private answer(socket: WebSocket, delayMs: number, text: string): void {
    if (delayMs <= 0) {
      socket.send(text);
      return;
    }
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }, delayMs);
  }

  /** Resolves once the client has said it is ready (message 7) this many times. */
  async ready(count = 1): Promise<void> {
    await until(() => this.signalingReceived.filter((message) => message.msg_type === 7).length >= count);
  }

  sendSignaling(message: Record<string, unknown>): void {
    this.signaling?.send(JSON.stringify(message));
  }

  sendMedia(message: Record<string, unknown>): void {
    this.media?.send(JSON.stringify(message));
  }

  /** A frame that is not text: samples as bytes. */
  sendMediaBinary(bytes: Buffer): void {
    this.media?.send(bytes, { binary: true });
  }

  sendAudio(samples: Int16Array, timestamp = Date.now()): void {
    this.sendMedia({ msg_type: 14, content: { user_id: 0, data: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64'), length: samples.byteLength, timestamp } });
  }

  sendSpeaker(name: string): void {
    this.sendSignaling({ msg_type: 6, event: { event_type: 2, timestamp: Date.now(), user_id: 16778240, user_name: name } });
  }

  keepAlive(timestamp: number): void {
    this.sendSignaling({ msg_type: 12, timestamp });
    this.sendMedia({ msg_type: 12, timestamp });
  }

  /** The stream ends on Zoom's side for a reason: the update, then both connections closed. */
  terminate(reason: number): void {
    this.sendSignaling({ msg_type: 8, state: 4, reason, timestamp: Date.now() });
    const signaling = this.signaling;
    const media = this.media;
    setTimeout(() => {
      signaling?.close();
      media?.close();
    }, 5);
  }

  dropSignaling(): void {
    this.signaling?.terminate();
  }

  dropMedia(): void {
    this.media?.terminate();
  }
}

/** A tone as 20-millisecond frames of 16 kHz mono samples. */
export function tone(frames: number, hz = 440, amplitude = 8_000): Int16Array[] {
  return Array.from({ length: frames }, (_, f) => Int16Array.from({ length: 320 }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * hz * (f * 320 + i)) / 16_000))));
}
