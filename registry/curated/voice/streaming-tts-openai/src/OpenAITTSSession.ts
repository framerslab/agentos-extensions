// @ts-nocheck
/**
 * @file OpenAITTSSession.ts
 * @description Active TTS session backed by the OpenAI Audio Speech API.
 *
 * {@link OpenAITTSSession} implements the `StreamingTTSSession` interface
 * (EventEmitter) and provides the following events:
 *
 * | Event                | Payload                    | Description                                     |
 * |----------------------|----------------------------|-------------------------------------------------|
 * | `'utterance_start'`  | `{ text: string }`         | Sentence chunk dispatched for synthesis         |
 * | `'audio'`            | `EncodedAudioChunk`        | Core audio event; PCM (raw or WAV), MP3 or Opus |
 * | `'audio_chunk'`      | `EncodedAudioChunk`        | Synthesised audio buffer ready for playback     |
 * | `'utterance_complete'`| `{ text, durationMs }`    | Synthesis complete for a sentence chunk         |
 * | `'flush_complete'`   | (none)                     | Flushed batch synthesised without an error      |
 * | `'cancelled'`        | `{ remaining: string }`    | Session cancelled; remaining text not rendered  |
 * | `'error'`            | `Error`                    | Unrecoverable synthesis error                   |
 * | `'close'`            | —                          | Session fully terminated                        |
 *
 * ### Pipelining
 * Sentences are requested and emitted in input order. A request begins only
 * after its predecessor has emitted audio or reported failure. The legacy
 * events remain available; core consumers receive `audio` and `flush_complete`.
 * This event-only compatibility path does not implement an awaited audio sink.
 * PCM16 WAV metadata comes from the returned container and sample count, not text length.
 *
 * @module streaming-tts-openai/OpenAITTSSession
 */

import { EventEmitter } from 'node:events';
import { AdaptiveSentenceChunker } from './AdaptiveSentenceChunker.js';
import type { OpenAIStreamingTTSConfig, StreamingTTSConfig, EncodedAudioChunk } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OpenAI TTS API sample rate — always 24 kHz regardless of format. */
const SAMPLE_RATE_HZ = 24_000;

/**
 * Rough estimate of spoken word rate used to compute {@link EncodedAudioChunk.durationMs}.
 * 150 words per minute = 2.5 words per second.
 */
const WORDS_PER_MS = 150 / 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the spoken duration in milliseconds for a given sentence.
 *
 * Uses a simple word-count heuristic (150 WPM) rather than decoding the audio,
 * which would require codec-specific libraries.  Callers should treat the result
 * as a hint rather than a precise measurement.
 *
 * @param text - The synthesised sentence.
 * @returns Estimated playback duration in milliseconds.
 */
function estimateDurationMs(text: string): number {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(200, Math.round(wordCount / WORDS_PER_MS));
}

/**
 * Read the sample rate and duration of a PCM16 mono WAV synthesis response.
 *
 * Duration comes from the `data` chunk's sample count, never from the text. A
 * container that is not PCM16 mono at its declared byte rate, or whose chunk
 * sizes disagree with its length, is refused.
 *
 * @param audio - The complete WAV response body.
 * @returns The declared sample rate and the measured duration in milliseconds.
 * @throws Error when the container is malformed or is not PCM16 mono.
 */
function wavMetadata(audio: Buffer): { sampleRate: number; durationMs: number } {
  const fail = (): never => { throw new Error('invalid synthesis WAV'); };
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) + 8 !== audio.length) return fail();
  let sampleRate = 0; let samples = 0; let foundData = false; let offset = 12;
  while (offset < audio.length) {
    if (offset + 8 > audio.length) return fail();
    const kind = audio.toString('ascii', offset, offset + 4); const size = audio.readUInt32LE(offset + 4); const begin = offset + 8; const end = begin + size;
    if (end > audio.length) return fail();
    if (kind === 'fmt ') {
      if (sampleRate || size < 16 || audio.readUInt16LE(begin) !== 1 || audio.readUInt16LE(begin + 2) !== 1 || audio.readUInt16LE(begin + 12) !== 2 || audio.readUInt16LE(begin + 14) !== 16) return fail();
      sampleRate = audio.readUInt32LE(begin + 4);
      if (sampleRate < 8000 || sampleRate > 192000 || audio.readUInt32LE(begin + 8) !== sampleRate * 2) return fail();
    } else if (kind === 'data') {
      if (foundData || !size || size % 2) return fail(); foundData = true; samples = size / 2;
    }
    offset = end + size % 2;
  }
  if (!sampleRate || !foundData || offset !== audio.length) return fail();
  return { sampleRate, durationMs: samples * 1000 / sampleRate };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Active streaming TTS session backed by the OpenAI Audio Speech API.
 *
 * Construct via {@link OpenAIStreamingTTS.startSession} rather than directly.
 *
 * @example
 * ```ts
 * const session = new OpenAITTSSession(
 *   { apiKey: process.env.OPENAI_API_KEY! },
 *   {},
 * );
 *
 * session.on('audio_chunk', (chunk) => audioPlayer.enqueue(chunk.audio));
 * session.on('utterance_complete', ({ text, durationMs }) => {
 *   console.log(`Synthesised "${text}" in ~${durationMs} ms`);
 * });
 *
 * llm.on('token', (tok) => session.pushTokens(tok));
 * llm.on('end',   ()    => session.flush());
 * ```
 */
export class OpenAITTSSession extends EventEmitter {
  // -------------------------------------------------------------------------
  // Resolved config
  // -------------------------------------------------------------------------

  /** Full API base URL (no trailing slash). */
  private readonly baseUrl: string;

  /** TTS model name. */
  private readonly model: string;

  /** Voice preset. */
  private readonly voice: string;

  /** Audio output format / codec. */
  private readonly format: string;

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  /** Sentence boundary detector fed by {@link pushTokens}. */
  private readonly chunker: AdaptiveSentenceChunker;

  /**
   * Ordered promise chain that serialises synthesis requests and emission.
   *
   * Each new sentence appends its whole request, from HTTP admission to its
   * audio events, to the tail of the chain, so requests run one at a time and
   * `audio` and `audio_chunk` events fire in the same order as the input text.
   */
  private fetchChain: Promise<void> = Promise.resolve();

  private failures = 0;
  private reportedFailures = 0;
  /** The chain tail the last flush drained and whether its batch failed, shared by every flush already waiting on that tail. */
  private drained: { tail: Promise<void>; failed: boolean } | undefined;
  /** An exception thrown while delivering `error` (no listener, or a listener that throws); the next flush rethrows it. */
  private deliveryFailure: { error: unknown } | undefined;

  /**
   * Set of AbortControllers for all in-flight fetch requests.
   *
   * Used by {@link cancel} to abort every pending HTTP call immediately.
   */
  private readonly abortControllers: Set<AbortController> = new Set();

  /** `true` after {@link close} or {@link cancel} is called. */
  private closed = false;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * @param providerConfig - OpenAI-specific configuration (apiKey required).
   * @param _sessionConfig - Generic voice-pipeline session config (currently
   *   used only for future `language` forwarding).
   */
  constructor(
    private readonly providerConfig: OpenAIStreamingTTSConfig,
    _sessionConfig: StreamingTTSConfig,
  ) {
    super();

    // Apply defaults.
    this.baseUrl = (providerConfig.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
    this.model   = providerConfig.model   ?? 'tts-1';
    this.voice   = providerConfig.voice   ?? 'nova';
    this.format  = providerConfig.format  ?? 'opus';

    const maxBufferMs = providerConfig.maxBufferMs ?? 2000;
    this.chunker = new AdaptiveSentenceChunker(maxBufferMs);

    // Wire chunker → fetch pipeline.
    this.chunker.on('sentence', (sentence: string) => {
      this.enqueueFetch(sentence);
    });
  }

  // -------------------------------------------------------------------------
  // StreamingTTSSession interface
  // -------------------------------------------------------------------------

  /**
   * Push LLM output token(s) into the sentence chunker.
   *
   * The chunker will buffer tokens and emit a `'sentence'` event once a
   * boundary is detected or the flush timer expires.
   *
   * @param text - One or more LLM token characters to append.
   */
  pushTokens(text: string): void {
    if (this.closed) return;
    this.chunker.pushTokens(text);
  }

  /**
   * Drain this text batch; core completion is emitted only if every request succeeded.
   *
   * @throws The first exception thrown while delivering `error` since the previous flush.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    this.chunker.flush();
    const tail = this.fetchChain;
    // A flush that starts after its tail was drained has an empty batch of its own.
    const drainedBefore = this.drained?.tail === tail;
    await tail;
    // Flushes that awaited the same tail share one outcome, so a failed batch never completes.
    if (drainedBefore || this.drained?.tail !== tail) {
      this.drained = { tail, failed: this.failures !== this.reportedFailures };
      this.reportedFailures = this.failures;
    }
    const thrown = this.deliveryFailure; this.deliveryFailure = undefined;
    if (thrown) throw thrown.error;
    if (!this.closed && !this.drained.failed) this.emit('flush_complete');
  }

  /**
   * Abort all in-flight synthesis requests and emit a `'cancelled'` event
   * carrying any text that was still buffered in the chunker at the time of
   * cancellation.
   *
   * No further events are emitted after `cancel()`.
   */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;

    // Retrieve unsynthesised text from the chunker before aborting.
    const remaining = this.chunker.cancel();

    // Abort every in-flight fetch.
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    this.emit('cancelled', { remaining });
  }

  /**
   * Perform orderly teardown of the session.
   *
   * Cancels the chunker timer, aborts any remaining fetches, and emits a
   * `'close'` event.  Idempotent — safe to call multiple times.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.chunker.cancel();

    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();

    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Internal — fetch pipeline
  // -------------------------------------------------------------------------

  /**
   * Append a sentence to the request chain. Both HTTP admission and emission
   * happen inside the chain, so a fast second response cannot overtake the first.
   * @param sentence - The complete sentence to synthesize.
   */
  private enqueueFetch(sentence: string): void {
    if (this.closed) return;
    // The tail always settles: a sentence whose error delivery throws fails only
    // itself, later sentences still run, and the next flush rethrows the exception.
    this.fetchChain = this.fetchChain
      .then(async () => { if (!this.closed) await this.synthesise(sentence); })
      .catch((error: unknown) => { this.deliveryFailure ??= { error }; });
  }

  /**
   * Perform the OpenAI TTS HTTP request for a single sentence and emit the
   * corresponding audio events.
   *
   * Emits (in order):
   * 1. `'utterance_start'` before the request begins.
   * 2. `'audio'` with the core chunk, when the format is PCM, WAV, MP3 or Opus.
   * 3. `'audio_chunk'` with the synthesised audio buffer.
   * 4. `'utterance_complete'` after the buffer is ready.
   *
   * A failed request emits `error` and increments the batch failure count.
   * Legacy flush still resolves after draining, but emits no core completion
   * for that failed batch. When delivering `error` throws, later sentences
   * still run and the next flush rejects with that exception. Cancellation
   * suppresses admitted late responses.
   *
   * @param sentence - The sentence text to synthesise.
   */
  private async synthesise(sentence: string): Promise<void> {
    if (this.closed) return;
    const coreFormat = this.format === 'wav' ? 'pcm' : this.format;
    const supported = coreFormat === 'pcm' || coreFormat === 'mp3' || coreFormat === 'opus';
    if (this.listenerCount('audio') > 0 && !supported) {
      this.failures += 1; this.emit('error', new Error('OpenAI TTS format is unsupported by the core audio contract')); return;
    }
    this.emit('utterance_start', { text: sentence });
    if (this.closed) return;
    const controller = new AbortController(); this.abortControllers.add(controller);
    try {
      const response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.providerConfig.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, voice: this.voice, input: sentence, response_format: this.format }),
      });
      if (!response.ok) throw new Error(`OpenAI TTS request failed (${response.status})`);
      const audio = Buffer.from(await response.arrayBuffer());
      if (this.closed || controller.signal.aborted) return;
      const measured = this.format === 'wav' ? wavMetadata(audio) : { sampleRate: SAMPLE_RATE_HZ, durationMs: this.format === 'pcm' ? audio.length / (SAMPLE_RATE_HZ * 2) * 1000 : estimateDurationMs(sentence) };
      const durationMs = measured.durationMs;
      const legacy: EncodedAudioChunk = { audio, format: this.format, sampleRate: measured.sampleRate, durationMs, text: sentence };
      if (supported) this.emit('audio', {
        ...legacy, format: coreFormat,
        ...(this.format === 'wav' ? { container: 'wav', channels: 1 } : this.format === 'pcm' ? { container: 'raw', channels: 1 } : {}),
      });
      if (this.closed) return;
      this.emit('audio_chunk', legacy);
      if (!this.closed) this.emit('utterance_complete', { text: sentence, durationMs });
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      this.failures += 1;
      this.emit('error', error instanceof Error ? error : new Error('OpenAI synthesis failed'));
    } finally { this.abortControllers.delete(controller); }
  }
}
