// @ts-nocheck
/**
 * @file ElevenLabsTTSSession.ts
 * @description Active TTS session backed by the ElevenLabs WebSocket Streaming API.
 *
 * {@link ElevenLabsTTSSession} implements the `StreamingTTSSession` interface
 * (EventEmitter) and provides the following events:
 *
 * | Event                | Payload                    | Description                                          |
 * |----------------------|----------------------------|------------------------------------------------------|
 * | `'audio'`            | `EncodedAudioChunk`        | Core audio event; same MP3 chunk as `audio_chunk`    |
 * | `'audio_chunk'`      | `EncodedAudioChunk`        | MP3 audio buffer from ElevenLabs, ready for playback |
 * | `'utterance_complete'`| `{ text, durationMs }`    | ElevenLabs signalled end of audio generation         |
 * | `'flush_complete'`   | (none)                     | Remote final received; synthesis complete            |
 * | `'cancelled'`        | `{ remaining: string }`    | Session cancelled; remaining text not rendered       |
 * | `'error'`            | `Error`                    | WebSocket or protocol error                          |
 * | `'close'`            | —                          | Session fully terminated                             |
 *
 * ### Protocol Overview
 *
 * The ElevenLabs WebSocket streaming protocol works as follows:
 *
 * 1. Open WSS connection to the voice/model endpoint.
 * 2. Send a BOS (Beginning-Of-Stream) message: `{ text: " ", voice_settings: {...}, xi_api_key }`.
 * 3. Stream text tokens as `{ text: "..." }` JSON messages.
 * 4. To generate audio for accumulated text, include `flush: true` in the text message.
 * 5. To end the stream, send an EOS (End-Of-Stream) message: `{ text: "" }`.
 * 6. JSON audio envelopes carry base64 MP3. Binary audio remains accepted for compatibility.
 * 7. When all audio has been generated the server sends `{ isFinal: true }`.
 *
 * `audio` and `audio_chunk` carry each decoded chunk in wire order. One remote
 * final emits `utterance_complete` and `flush_complete`. Queuing EOS and closing
 * the socket are not completion. Durations remain legacy estimates; this pack
 * does not provide the awaited, bounded output required by the hosted profile.
 *
 * @module streaming-tts-elevenlabs/ElevenLabsTTSSession
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ElevenLabsStreamingTTSConfig, StreamingTTSConfig, EncodedAudioChunk } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ElevenLabs WebSocket API base URL. */
const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io';

/** Default voice ID — Rachel (a neutral, clear English voice). */
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/** Default model — ElevenLabs Turbo v2, optimized for low latency. */
const DEFAULT_MODEL_ID = 'eleven_turbo_v2';

/** MP3 output format at 44.1 kHz / 128 kbps. */
const OUTPUT_FORMAT = 'mp3_44100_128';

/** Sample rate that matches the OUTPUT_FORMAT specifier. */
const SAMPLE_RATE_HZ = 44_100;

/**
 * Rough estimate of spoken word rate used to compute {@link EncodedAudioChunk.durationMs}.
 * 150 words per minute.
 */
const WORDS_PER_MS = 150 / 60_000;

/** Regex matching sentence-final punctuation. */
const SENTENCE_BOUNDARY_RE = /[.?!]/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the spoken duration in milliseconds for a piece of text.
 *
 * Uses a simple word-count heuristic (150 WPM).  Callers should treat the result
 * as a hint rather than a precise measurement.
 *
 * @param text - The text to estimate duration for.
 * @returns Estimated playback duration in milliseconds (minimum 200 ms).
 */
function estimateDurationMs(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(200, Math.round(wordCount / WORDS_PER_MS));
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Active streaming TTS session backed by the ElevenLabs WebSocket Streaming API.
 *
 * Construct via {@link ElevenLabsStreamingTTS.startSession} rather than directly.
 *
 * @example
 * ```ts
 * const session = new ElevenLabsTTSSession(
 *   { apiKey: process.env.ELEVENLABS_API_KEY! },
 *   {},
 * );
 *
 * session.on('audio_chunk', (chunk) => audioPlayer.enqueue(chunk.audio));
 * session.on('utterance_complete', ({ text, durationMs }) => {
 *   console.log(`Synthesis complete ~${durationMs} ms`);
 * });
 *
 * llm.on('token', (tok) => session.pushTokens(tok));
 * llm.on('end',   ()    => session.flush());
 * ```
 */
export class ElevenLabsTTSSession extends EventEmitter {
  // -------------------------------------------------------------------------
  // Resolved config
  // -------------------------------------------------------------------------

  /** ElevenLabs voice ID. */
  private readonly voiceId: string;

  /** ElevenLabs model ID. */
  private readonly modelId: string;

  /** Voice stability (0.0 – 1.0). */
  private readonly stability: number;

  /** Similarity boost (0.0 – 1.0). */
  private readonly similarityBoost: number;

  /** Style exaggeration (0.0 – 1.0). */
  private readonly style: number;

  /** Whether to enable speaker boost. */
  private readonly useSpeakerBoost: boolean;

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  /** Live WebSocket connection to the ElevenLabs streaming endpoint. */
  private readonly ws: WebSocket;

  /**
   * Text that has been pushed since the last sentence-boundary flush.
   *
   * Accumulated so that `cancel()` can report the remaining un-synthesised text.
   */
  private pendingText = '';

  /** `true` after {@link close} or {@link cancel} is called. */
  private closed = false;

  /** `true` once {@link flush} has queued EOS; later tokens and flushes are ignored. */
  private eosQueued = false;

  /** `true` once the server's final message has been handled; later messages are ignored. */
  private finalReceived = false;

  /** All text accepted by {@link pushTokens}, reported by `utterance_complete`. */
  private totalText = '';

  /**
   * Whether the BOS (beginning-of-stream) message has been sent.
   *
   * The BOS is sent once on `ws.open`; subsequent messages are plain text sends.
   */
  private bosAcknowledged = false;

  /**
   * Queue of text segments that need to be sent once the WebSocket opens.
   *
   * If `pushTokens` or `flush` is called before the socket is open, messages
   * are queued here and drained on `ws.open`.
   */
  private readonly sendQueue: Array<object> = [];

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * @param providerConfig - ElevenLabs-specific configuration (apiKey required).
   * @param _sessionConfig - Generic voice-pipeline session config (reserved for
   *   future `language` forwarding).
   */
  constructor(
    private readonly providerConfig: ElevenLabsStreamingTTSConfig,
    _sessionConfig: StreamingTTSConfig,
  ) {
    super();

    // Apply defaults.
    this.voiceId        = providerConfig.voiceId        ?? DEFAULT_VOICE_ID;
    this.modelId        = providerConfig.modelId        ?? DEFAULT_MODEL_ID;
    this.stability      = providerConfig.stability      ?? 0.5;
    this.similarityBoost= providerConfig.similarityBoost ?? 0.75;
    this.style          = providerConfig.style          ?? 0.0;
    this.useSpeakerBoost= providerConfig.useSpeakerBoost ?? true;

    // Build the WebSocket endpoint URL.
    const wsUrl =
      `${ELEVENLABS_WS_BASE}/v1/text-to-speech/${this.voiceId}/stream-input` +
      `?model_id=${this.modelId}&output_format=${OUTPUT_FORMAT}`;

    this.ws = new WebSocket(wsUrl);

    this._wireWebSocket();
  }

  // -------------------------------------------------------------------------
  // StreamingTTSSession interface
  // -------------------------------------------------------------------------

  /** Send each token once; punctuation requests synthesis without resending prior tokens. */
  pushTokens(text: string): void {
    if (this.closed || this.eosQueued || this.finalReceived || !text) return;
    this.pendingText += text; this.totalText += text;
    const boundary = SENTENCE_BOUNDARY_RE.test(text);
    this._send(boundary ? { text, flush: true } : { text });
    if (boundary) this.pendingText = '';
  }

  /** Queue EOS once. Listen for flush_complete to observe actual remote synthesis completion. */
  async flush(): Promise<void> {
    if (this.closed || this.eosQueued || this.finalReceived) return;
    this.eosQueued = true;
    this._send({ text: '' });
  }

  /** Discard queued messages and prevent an open event from admitting work after cancellation. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    const remaining = this.pendingText;
    this.pendingText = ''; this.sendQueue.length = 0;
    this.ws.close(); this.emit('cancelled', { remaining });
  }

  /** Close the socket once; socket closure alone never reports completed synthesis. */
  close(): void {
    if (this.closed) return;
    this.closed = true; this.sendQueue.length = 0;
    this.ws.close(); this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Internal — WebSocket wiring
  // -------------------------------------------------------------------------

  /**
   * Attach event listeners to the WebSocket instance and handle the full
   * message lifecycle.
   */
  private _wireWebSocket(): void {
    this.ws.on('open', () => {
      if (this.closed) return;
      this.ws.send(JSON.stringify({ text: ' ', voice_settings: {
        stability: this.stability, similarity_boost: this.similarityBoost,
        style: this.style, use_speaker_boost: this.useSpeakerBoost,
      }, xi_api_key: this.providerConfig.apiKey }));
      this.bosAcknowledged = true;
      for (const queued of this.sendQueue) {
        if (this.closed) break;
        this.ws.send(JSON.stringify(queued));
      }
      this.sendQueue.length = 0;
    });
    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.closed || this.finalReceived) return;
      if (isBinary) {
        const audio = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        this._emitAudio(audio); return;
      }
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
        msg = parsed as Record<string, unknown>;
      } catch { this.emit('error', new Error('ElevenLabs status envelope invalid')); return; }
      if (msg.error !== undefined) { this.emit('error', new Error('ElevenLabs synthesis failed')); return; }
      if (msg.audio !== undefined && msg.audio !== null && msg.audio !== '') {
        if (typeof msg.audio !== 'string' || msg.audio.length > 8388608 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.audio)) {
          this.emit('error', new Error('ElevenLabs audio envelope invalid')); return;
        }
        this._emitAudio(Buffer.from(msg.audio, 'base64'));
      }
      if (msg.isFinal === true && !this.closed) {
        this.finalReceived = true;
        this.emit('utterance_complete', { text: this.totalText, durationMs: estimateDurationMs(this.totalText) });
        if (!this.closed) this.emit('flush_complete');
      }
    });
    this.ws.on('error', () => { if (!this.closed) this.emit('error', new Error('ElevenLabs connection failed')); });
    this.ws.on('close', () => {
      if (!this.closed) { this.closed = true; this.sendQueue.length = 0; this.emit('close'); }
    });
  }

  /**
   * Emit one decoded MP3 chunk as `audio`, then as the legacy `audio_chunk`.
   * Nothing is emitted after closure, after the remote final or for an empty buffer.
   */
  private _emitAudio(audio: Buffer): void {
    if (this.closed || this.finalReceived || audio.length === 0) return;
    const chunk: EncodedAudioChunk = { audio, format: 'mp3', sampleRate: SAMPLE_RATE_HZ, durationMs: estimateDurationMs(this.pendingText), text: '' };
    this.emit('audio', chunk);
    if (!this.closed) this.emit('audio_chunk', chunk);
  }

  /**
   * Send a JSON message over the WebSocket.
   *
   * If the socket is not yet open, the message is queued and will be sent once
   * the `open` event fires (after the BOS message is dispatched).
   * Nothing is sent or queued once the session is closed or cancelled.
   *
   * @param msg - The message object to serialise and send.
   */
  private _send(msg: object): void {
    if (this.closed) return;
    if (this.bosAcknowledged && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Queue for post-open delivery.
      this.sendQueue.push(msg);
    }
  }
}
