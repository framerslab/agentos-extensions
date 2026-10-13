/**
 * One stream's two connections to Zoom: the signaling connection (the handshake, keep-alives, the active speaker, the
 * stream's state, the close request) and the media connection (the handshake, keep-alives, the audio). It re-makes a
 * dropped media connection alone and a dropped signaling connection with both, each attempt after a pause that doubles,
 * inside Zoom's windows; it ends with Zoom's reason when Zoom ends the stream, and without one when a window runs out.
 * Nothing here knows what a run is.
 *
 * @module
 */
import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { firstServerUrl } from '../webhook.js';
import {
  SESSION_STATE,
  STREAM_STATE,
  clientReady,
  decodePcm16,
  keepAliveResponse,
  mediaHandshake,
  pcm16Of,
  readServerMessage,
  rtmsSignature,
  signalingHandshake,
  streamCloseRequest,
  subscribeActiveSpeaker,
  type PcmByteOrder,
  type RtmsServerMessage,
  type SignatureEncoding,
} from './messages.js';

/** How a dropped connection is re-made: the first pause, the longest pause, and how long each connection may stay down before the stream is lost. */
export interface RtmsReconnectOptions {
  /** The pause before the first attempt; it doubles after each. Zoom's samples start at 3 seconds. */
  baseMs: number;
  /** The longest pause. Zoom's samples stop at 30 seconds. */
  maxMs: number;
  /** How long a lost signaling connection is retried: Zoom waits about 60 seconds. */
  signalingWindowMs: number;
  /** How long a lost media connection is retried: Zoom waits about 30 seconds. */
  mediaWindowMs: number;
}

/** What a stream needs: the app's client id and secret, the meeting and stream ids Zoom named, the signaling address, and the parameters the pages leave open. */
export interface RtmsStreamOptions {
  clientId: string;
  clientSecret: string;
  meetingUuid: string;
  streamId: string;
  /** The started event's `server_urls`. */
  serverUrls: string;
  signatureEncoding?: SignatureEncoding;
  /** The signaling handshake's sequence number. Default 1. */
  signalingSequence?: number;
  pcmByteOrder?: PcmByteOrder;
  /** Makes a connection. A test passes one that reaches its local server. */
  connect?: (url: string) => WebSocket;
  reconnect?: Partial<RtmsReconnectOptions>;
  /** A connection with no keep-alive for this long is re-made. Default 65 seconds. */
  keepAliveSilenceMs?: number;
  /** Bounds each handshake even when the socket remains open. Default ten seconds. */
  handshakeMs?: number;
  clock?: () => number;
}

type RtmsStreamEvents = {
  /** Both handshakes are done for the first time and media may flow. */
  ready: [];
  /** A connection dropped and is being re-made. */
  interrupted: [];
  /** The connections are back after an interruption. */
  restored: [];
  audio: [samples: Int16Array, timestamp: number];
  speaker: [name: string, timestamp: number];
  /** Zoom ended the stream (with its reason), or a window for reconnecting ran out (without one). */
  ended: [stopReason: number | undefined];
  /** Zoom refused a handshake: `signaling_refused:<status>` or `media_refused:<status>`. Never retried. */
  failed: [code: string];
};

const DEFAULT_RECONNECT: RtmsReconnectOptions = { baseMs: 3_000, maxMs: 30_000, signalingWindowMs: 55_000, mediaWindowMs: 28_000 };

/** Drops a connection without a word and without a late error reaching anyone. */
function drop(socket: WebSocket | undefined): void {
  if (socket === undefined) return;
  socket.removeAllListeners();
  socket.on('error', () => undefined);
  try {
    socket.terminate();
  } catch {
    // a connection that never opened has nothing to end
  }
}

/**
 * One stream's two connections to Zoom: the handshakes, the keep-alives, the active speaker, reconnection inside Zoom's
 * windows and the close request; it emits the audio and the stream's events.
 */
export class RtmsStream extends EventEmitter<RtmsStreamEvents> {
  private state: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closing' | 'closed' = 'idle';
  private signaling: WebSocket | undefined;
  private signalingReady = false;
  private subscribed = false;
  private media: WebSocket | undefined;
  private mediaUrl: string | undefined;
  private serverUrls: string;
  private everReady = false;
  private stopReason: number | undefined;
  private attempts = 0;
  private outageSince: number | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastKeepAliveAt = 0;
  private lastMediaKeepAliveAt = 0;
  private signalingDeadline: number | undefined;
  private mediaDeadline: number | undefined;
  private outageDeadline: number | undefined;
  private closureConfirmed = false;
  private closeWaiter: ((confirmed: boolean) => void) | undefined;
  private readonly signature: string;
  private readonly windows: RtmsReconnectOptions;

  constructor(private readonly options: RtmsStreamOptions) {
    super();
    this.serverUrls = options.serverUrls;
    this.signature = rtmsSignature({ clientId: options.clientId, clientSecret: options.clientSecret, meetingUuid: options.meetingUuid, streamId: options.streamId, encoding: options.signatureEncoding });
    this.windows = { ...DEFAULT_RECONNECT, ...options.reconnect };
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  /** True while a signaling connection is open and Zoom accepted its handshake. */
  get signalingOpen(): boolean {
    return this.signalingReady && this.signaling?.readyState === WebSocket.OPEN;
  }

  /** Opens the signaling connection; the media connection follows its answer. */
  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    this.lastKeepAliveAt = this.now();
    const silence = this.options.keepAliveSilenceMs ?? 65_000;
    this.watchdog = setInterval(() => {
      if (this.state === 'closing' || this.state === 'closed') return;
      const now = this.now();
      if (this.outageDeadline !== undefined && now >= this.outageDeadline) {
        this.shutdown();
        this.emit('ended', undefined);
        return;
      }
      if (this.signalingDeadline !== undefined && now >= this.signalingDeadline) return this.interrupt();
      if (this.mediaDeadline !== undefined && now >= this.mediaDeadline) return this.reopenMedia();
      if (this.signalingReady && now - this.lastKeepAliveAt >= silence) return this.interrupt();
      if (this.state === 'ready' && now - this.lastMediaKeepAliveAt >= silence) this.reopenMedia();
    }, Math.max(1, Math.min(1_000, silence / 4, (this.options.handshakeMs ?? 10_000) / 4)));
    this.watchdog.unref?.();
    this.openSignaling();
  }

  private connectTo(url: string): WebSocket {
    return this.options.connect ? this.options.connect(url) : new WebSocket(url);
  }

  private send(socket: WebSocket | undefined, message: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private openSignaling(): void {
    let url: string;
    try {
      url = firstServerUrl(this.serverUrls);
    } catch {
      this.fail('no_address');
      return;
    }
    const socket = this.connectTo(url);
    this.signaling = socket;
    this.signalingReady = false;
    this.signalingDeadline = this.now() + (this.options.handshakeMs ?? 10_000);
    this.subscribed = false;
    socket.on('open', () => this.send(socket, signalingHandshake({ meetingUuid: this.options.meetingUuid, streamId: this.options.streamId, signature: this.signature, sequence: this.options.signalingSequence })));
    socket.on('message', (data: RawData) => this.onSignaling(socket, data.toString()));
    socket.on('error', () => undefined); // the close that follows is what is acted on
    socket.on('close', () => this.onSignalingClosed(socket));
  }

  private onSignaling(socket: WebSocket, text: string): void {
    if (socket !== this.signaling) return;
    let message: RtmsServerMessage;
    try {
      message = readServerMessage(text);
    } catch {
      return;
    }
    switch (message.kind) {
      case 'signaling_handshake':
        if (message.statusCode !== 0) return this.fail(`signaling_refused:${message.statusCode}`);
        if (message.audioUrl === undefined) return this.fail('no_audio_address');
        this.signalingReady = true;
        this.signalingDeadline = undefined;
        this.lastKeepAliveAt = this.now();
        this.mediaUrl = message.audioUrl;
        this.openMedia();
        return;
      case 'keep_alive':
        this.lastKeepAliveAt = this.now();
        this.send(socket, keepAliveResponse(message.timestamp));
        return;
      case 'speaker':
        this.emit('speaker', message.name, message.timestamp);
        return;
      case 'media_interrupted':
        this.reopenMedia();
        return;
      case 'session_state':
        if (message.state === SESSION_STATE.STOPPED) {
          this.stopReason = message.reason;
          this.closureConfirmed = true;
          if (this.state === 'closing') this.closeWaiter?.(true);
          else this.end();
        }
        return;
      case 'stream_state':
        if (message.state === STREAM_STATE.TERMINATED) {
          if (message.reason !== undefined) this.stopReason = message.reason;
          this.closureConfirmed = true;
          if (this.state === 'closing') this.closeWaiter?.(true);
          else this.end();
        }
        return;
      case 'close_response':
        this.closureConfirmed = message.statusCode === 0;
        this.closeWaiter?.(this.closureConfirmed);
        return;
      default:
        return;
    }
  }

  private onSignalingClosed(socket: WebSocket): void {
    if (socket !== this.signaling) return;
    this.signaling = undefined;
    this.signalingReady = false;
    if (this.state === 'closing') {
      this.closeWaiter?.(this.closureConfirmed);
      return;
    }
    if (this.state === 'closed') return;
    // Zoom said why before it hung up: that is the stream's end, not an interruption
    if (this.stopReason !== undefined) return this.end();
    this.interrupt();
  }

  private openMedia(): void {
    if (this.mediaUrl === undefined) return;
    const socket = this.connectTo(this.mediaUrl);
    this.media = socket;
    this.mediaDeadline = this.now() + (this.options.handshakeMs ?? 10_000);
    socket.on('open', () => this.send(socket, mediaHandshake({ meetingUuid: this.options.meetingUuid, streamId: this.options.streamId, signature: this.signature })));
    socket.on('message', (data: RawData, isBinary: boolean) => this.onMedia(socket, data, isBinary));
    socket.on('error', () => undefined);
    socket.on('close', () => this.onMediaClosed(socket));
  }

  private onMedia(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.media) return;
    if (isBinary) {
      // a frame that is not text is taken as the samples themselves
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.mediaHealthy();
      this.emit('audio', pcm16Of(bytes, this.options.pcmByteOrder), this.now());
      return;
    }
    let message: RtmsServerMessage;
    try {
      message = readServerMessage(data.toString());
    } catch {
      return;
    }
    switch (message.kind) {
      case 'media_handshake':
        if (message.statusCode !== 0) return this.fail(`media_refused:${message.statusCode}`);
        this.mediaDeadline = undefined;
        this.lastMediaKeepAliveAt = this.now();
        this.send(this.signaling, clientReady(this.options.streamId));
        if (!this.subscribed) {
          this.send(this.signaling, subscribeActiveSpeaker());
          this.subscribed = true;
        }
        this.becomeReady();
        return;
      case 'keep_alive':
        this.mediaHealthy();
        this.send(socket, keepAliveResponse(message.timestamp));
        return;
      case 'audio':
        this.mediaHealthy();
        this.emit('audio', decodePcm16(message.data, this.options.pcmByteOrder), message.timestamp);
        return;
      default:
        return;
    }
  }

  private mediaHealthy(): void {
    this.lastMediaKeepAliveAt = this.now();
    if (this.state === 'ready') {
      this.outageSince = undefined;
      this.outageDeadline = undefined;
    }
  }

  private onMediaClosed(socket: WebSocket): void {
    if (socket !== this.media) return;
    this.media = undefined;
    if (this.state === 'closing' || this.state === 'closed') return;
    // a lost signaling connection re-makes both; a media connection lost on its own is re-made alone
    if (this.signaling !== undefined && this.signalingReady) this.reopenMedia();
  }

  private becomeReady(): void {
    const was = this.state;
    this.state = 'ready';
    // A handshake alone does not prove media health; keep an existing outage deadline until media arrives.
    this.attempts = 0;
    if (!this.everReady) {
      this.everReady = true;
      this.emit('ready');
    } else if (was === 'reconnecting') {
      this.emit('restored');
    }
  }

  private beginOutage(): void {
    if (this.state === 'reconnecting') return;
    this.state = 'reconnecting';
    this.outageSince = this.now();
    this.attempts = 0;
    this.emit('interrupted');
  }

  /** Tries again after the next pause, or gives the stream up once the window has passed. */
  private scheduleRetry(work: () => void, windowMs: number): void {
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.outageDeadline = Math.min(this.outageDeadline ?? Infinity, (this.outageSince ?? this.now()) + windowMs);
    if (this.now() >= this.outageDeadline) {
      this.shutdown();
      this.emit('ended', undefined);
      return;
    }
    const delay = Math.min(this.windows.baseMs * 2 ** this.attempts, this.windows.maxMs);
    this.attempts += 1;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.state === 'reconnecting') work();
    }, delay);
  }

  /** The signaling connection is gone: both are re-made. */
  private interrupt(): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    drop(this.signaling);
    drop(this.media);
    this.signaling = undefined;
    this.media = undefined;
    this.signalingReady = false;
    this.signalingDeadline = undefined;
    this.mediaDeadline = undefined;
    this.beginOutage();
    this.scheduleRetry(() => this.openSignaling(), this.windows.signalingWindowMs);
  }

  /** The media connection is gone or Zoom says it was interrupted: it is re-made alone. */
  private reopenMedia(): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    drop(this.media);
    this.media = undefined;
    this.mediaDeadline = undefined;
    this.beginOutage();
    this.scheduleRetry(() => {
      if (this.signaling !== undefined && this.signalingReady) this.openMedia();
      else this.interrupt();
    }, this.windows.mediaWindowMs);
  }

  /**
   * Re-makes both connections at once: Zoom's server failed over and sent the started event again, or Zoom said the
   * signaling connection was interrupted. New addresses replace the old when they are given.
   */
  reconnect(serverUrls?: string): void {
    if (this.state === 'idle' || this.state === 'closing' || this.state === 'closed') return;
    if (serverUrls !== undefined && serverUrls !== '') this.serverUrls = serverUrls;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    drop(this.signaling);
    drop(this.media);
    this.signaling = undefined;
    this.media = undefined;
    this.signalingReady = false;
    this.beginOutage();
    this.outageDeadline = Math.min(this.outageDeadline ?? Infinity, this.now() + this.windows.signalingWindowMs);
    this.openSignaling();
  }

  private fail(code: string): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.shutdown();
    this.emit('failed', code);
  }

  private end(): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    this.shutdown();
    this.emit('ended', this.stopReason);
  }

  private shutdown(): void {
    this.state = 'closed';
    if (this.retry !== undefined) clearTimeout(this.retry);
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.retry = undefined;
    this.watchdog = undefined;
    drop(this.signaling);
    drop(this.media);
    this.signaling = undefined;
    this.media = undefined;
    this.signalingReady = false;
  }

  /**
   * Asks Zoom to close the stream and drops both connections. True only after status 0 or authoritative termination
   * within the wait; false when no accepted signaling connection was open to ask on, or Zoom did not answer in time.
   * No `ended` follows: the caller ended it.
   */
  async close(waitMs = 5_000): Promise<boolean> {
    if (this.state === 'closed' || this.state === 'closing') return this.closureConfirmed;
    const socket = this.signaling;
    const open = this.signalingOpen;
    this.state = 'closing';
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    let confirmed = false;
    if (open && socket !== undefined) {
      confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), waitMs);
        this.closeWaiter = (ok) => {
          clearTimeout(timer);
          resolve(ok);
        };
        this.send(socket, streamCloseRequest(this.options.streamId));
      });
      this.closeWaiter = undefined;
    }
    this.shutdown();
    return confirmed;
  }

  /** Drops both connections without a word to Zoom. */
  destroy(): void {
    this.shutdown();
  }
}

/**
 * Closes a stream nobody here asked for: a signaling connection, its handshake, the close request, and nothing else.
 * True when Zoom confirmed.
 */
export function closeStreamAtOnce(options: RtmsStreamOptions, waitMs = 5_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let url: string;
    try {
      url = firstServerUrl(options.serverUrls);
    } catch {
      resolve(false);
      return;
    }
    const socket = options.connect ? options.connect(url) : new WebSocket(url);
    const signature = rtmsSignature({ clientId: options.clientId, clientSecret: options.clientSecret, meetingUuid: options.meetingUuid, streamId: options.streamId, encoding: options.signatureEncoding });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      drop(socket);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on('open', () => socket.send(JSON.stringify(signalingHandshake({ meetingUuid: options.meetingUuid, streamId: options.streamId, signature, sequence: options.signalingSequence }))));
    socket.on('message', (data: RawData) => {
      let message: RtmsServerMessage;
      try {
        message = readServerMessage(data.toString());
      } catch {
        return;
      }
      if (message.kind === 'signaling_handshake') {
        if (message.statusCode !== 0) finish(false);
        else socket.send(JSON.stringify(streamCloseRequest(options.streamId)));
      } else if (message.kind === 'close_response') {
        finish(message.statusCode === 0);
      } else if (message.kind === 'keep_alive') {
        socket.send(JSON.stringify(keepAliveResponse(message.timestamp)));
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
