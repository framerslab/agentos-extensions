// @ts-nocheck
/**
 * @file WhisperChunkSession.ts
 * @description Active streaming STT session backed by the OpenAI Whisper HTTP API.
 *
 * {@link WhisperChunkSession} implements the `StreamingSTTSession` interface
 * (EventEmitter-based) using a sliding-window ring buffer to accumulate audio
 * into fixed-size chunks.  Each chunk is encoded as a RIFF/WAV file and posted
 * to the Whisper `/v1/audio/transcriptions` endpoint.
 *
 * ### Chunk lifecycle
 * 1. {@link pushAudio} feeds PCM frames into the internal {@link SlidingWindowBuffer}.
 * 2. When a full chunk is ready, {@link onChunkReady} is invoked.
 * 3. The chunk is WAV-encoded and POST-ed to Whisper with multipart/form-data.
 * 4. The parsed response is emitted as `transcript` and `interim_transcript`.
 * 5. The response text becomes the `prompt` for the next API call (continuity).
 *
 * ### Speech detection
 * A simple RMS energy threshold (`RMS_THRESHOLD = 0.01`) gates `speech_start`
 * and `speech_end` events.  This is not VAD — it is a lightweight proxy that
 * avoids emitting events on pure-silence frames.
 *
 * ### Error resilience
 * Each HTTP request waits for its predecessor. A failed request emits `error`;
 * subsequent requests retain the legacy retry-at-the-caller behavior. Flush
 * waits for admitted work and emits no successful final for a failed batch.
 * This chunk adapter keeps its window and interim/final semantics; it does not
 * claim native acoustic streaming, scoped VAD, or a bounded hosted input queue.
 *
 * @module streaming-stt-whisper/WhisperChunkSession
 */

import { EventEmitter } from 'node:events';
import { SlidingWindowBuffer, DEFAULT_CHUNK_SIZE_SAMPLES, DEFAULT_OVERLAP_SAMPLES } from './SlidingWindowBuffer.js';
import type {
  WhisperChunkedConfig,
  AudioFrame,
  TranscriptEvent,
  TranscriptWord,
  WhisperTranscriptionResponse,
  WhisperSegment,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * RMS amplitude threshold above which audio is considered to contain speech.
 * Frames with RMS below this value are treated as silence.
 */
const RMS_THRESHOLD = 0.01;

/** Default Whisper model identifier. */
const DEFAULT_MODEL = 'whisper-1';

/** Default Whisper API base URL. */
const DEFAULT_BASE_URL = 'https://api.openai.com';

// ---------------------------------------------------------------------------
// WAV encoding helpers
// ---------------------------------------------------------------------------

/**
 * Write a 32-bit unsigned integer in little-endian byte order into a DataView.
 *
 * @param view - Target DataView.
 * @param offset - Byte offset within the view.
 * @param value - The value to write.
 */
function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, /* littleEndian */ true);
}

/**
 * Write a 16-bit unsigned integer in little-endian byte order into a DataView.
 *
 * @param view - Target DataView.
 * @param offset - Byte offset within the view.
 * @param value - The value to write.
 */
function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, /* littleEndian */ true);
}

/**
 * Encode a Float32 PCM sample array as a standard RIFF/WAV file.
 *
 * Produces a mono, 16-bit signed PCM, 16 kHz WAV file with a 44-byte RIFF
 * header followed by Int16 sample data.  The encoding is self-contained with
 * zero dependencies.
 *
 * RIFF header layout (44 bytes):
 * ```
 *  0-3   "RIFF"
 *  4-7   file size - 8  (uint32 LE)
 *  8-11  "WAVE"
 * 12-15  "fmt "
 * 16-19  chunk size = 16 (uint32 LE)
 * 20-21  audio format = 1 (PCM, uint16 LE)
 * 22-23  num channels = 1 (uint16 LE)
 * 24-27  sample rate = 16000 (uint32 LE)
 * 28-31  byte rate = sampleRate * numChannels * bitsPerSample/8 (uint32 LE)
 * 32-33  block align = numChannels * bitsPerSample/8 (uint16 LE)
 * 34-35  bits per sample = 16 (uint16 LE)
 * 36-39  "data"
 * 40-43  data size in bytes (uint32 LE)
 * 44+    Int16LE sample data
 * ```
 *
 * @param samples - Normalised Float32 PCM audio in the range [-1, 1].
 * @param sampleRate - Sample rate in Hz (default 16000).
 * @returns `ArrayBuffer` containing the complete WAV file.
 */
function encodeWav(samples: Float32Array, sampleRate = 16_000): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataByteLength = samples.length * bytesPerSample;
  const headerByteLength = 44;
  const totalByteLength = headerByteLength + dataByteLength;

  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // RIFF chunk descriptor
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  writeUint32LE(view, 4, totalByteLength - 8);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt sub-chunk
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  writeUint32LE(view, 16, 16); // sub-chunk size = 16 for PCM
  writeUint16LE(view, 20, 1); // audio format = 1 (PCM, no compression)
  writeUint16LE(view, 22, numChannels);
  writeUint32LE(view, 24, sampleRate);
  writeUint32LE(view, 28, sampleRate * numChannels * bytesPerSample); // byte rate
  writeUint16LE(view, 32, numChannels * bytesPerSample); // block align
  writeUint16LE(view, 34, bitsPerSample);

  // data sub-chunk
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  writeUint32LE(view, 40, dataByteLength);

  // PCM samples — clamp Float32 to [-1, 1] then scale to Int16 range.
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = Math.round(clamped * 0x7fff);
    view.setInt16(headerByteLength + i * bytesPerSample, int16, /* littleEndian */ true);
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// RMS energy helper
// ---------------------------------------------------------------------------

/**
 * Compute the root-mean-square energy of a sample array.
 *
 * Returns a value in [0, 1] for normalised Float32 audio.
 * Returns 0 for an empty array.
 *
 * @param samples - Float32 PCM samples.
 * @returns RMS amplitude.
 */
function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Active chunked Whisper STT session.
 *
 * Construct via {@link WhisperChunkedSTT.startSession} rather than directly.
 *
 * @example
 * ```ts
 * const session = new WhisperChunkSession({ apiKey: process.env.OPENAI_API_KEY! });
 *
 * session.on('interim_transcript', (evt) => console.log('chunk:', evt.text));
 * session.on('final_transcript',   (evt) => console.log('done:', evt.text));
 *
 * microphone.on('frame', (f) => session.pushAudio(f));
 * await session.flush();
 * session.close();
 * ```
 */
export class WhisperChunkSession extends EventEmitter {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Resolved Whisper API configuration. */
  private readonly cfg: Required<Pick<WhisperChunkedConfig, 'apiKey' | 'baseUrl' | 'model'>> &
    Pick<WhisperChunkedConfig, 'language'>;

  /** Sliding-window ring buffer feeding audio chunks. */
  private readonly slidingBuffer: SlidingWindowBuffer;

  /** Whether {@link close} has been called. */
  private closed = false;

  /** Whether the session is currently in a speech segment (above RMS threshold). */
  private inSpeech = false;

  /**
   * Transcript text from the most recently completed chunk.
   * Forwarded as `prompt` to the next Whisper API call for cross-chunk
   * lexical continuity.
   */
  private previousPrompt: string | undefined;

  private requests: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private lastTranscript: TranscriptEvent | undefined;
  private pendingFailure = false;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  /**
   * @param config - Whisper session configuration.  `apiKey` is required.
   */
  constructor(config: WhisperChunkedConfig) {
    super();

    this.cfg = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      model: config.model ?? DEFAULT_MODEL,
      language: config.language,
    };

    // Use config prompt as the initial previous prompt seed.
    this.previousPrompt = config.prompt;

    this.slidingBuffer = new SlidingWindowBuffer(
      config.chunkSizeSamples ?? DEFAULT_CHUNK_SIZE_SAMPLES,
      config.overlapSamples ?? DEFAULT_OVERLAP_SAMPLES,
    );

    // Wire up the buffer's chunk_ready event.
    this.slidingBuffer.on('chunk_ready', (chunk: Float32Array) => {
      const owned = chunk.slice();
      this.requests = this.requests.then(() => this.onChunkReady(owned));
      // Keep error-event behavior, but observe an error listener's thrown exception.
      void this.requests.catch(() => {});
    });
  }

  // -------------------------------------------------------------------------
  // StreamingSTTSession interface
  // -------------------------------------------------------------------------

  /**
   * Feed a raw audio frame into the session.
   *
   * The frame's samples are appended to the sliding-window buffer.  When the
   * buffer accumulates a full chunk, {@link onChunkReady} is invoked.
   *
   * Speech detection is performed on every frame: if the RMS energy crosses
   * {@link RMS_THRESHOLD}, `'speech_start'` is emitted on the first such frame
   * and `'speech_end'` when energy falls back below the threshold.
   *
   * @param frame - Audio frame with normalised Float32 samples.
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed) return;

    // RMS-based speech detection.
    const energy = rms(frame.samples);
    if (energy > RMS_THRESHOLD && !this.inSpeech) {
      this.inSpeech = true;
      this.emit('speech_start');
    } else if (energy <= RMS_THRESHOLD && this.inSpeech) {
      this.inSpeech = false;
      this.emit('speech_end');
    }

    this.slidingBuffer.pushSamples(frame.samples);
  }

  /** Drain queued HTTP recognition and emit a final core transcript plus its legacy alias. */
  async flush(): Promise<void> {
    if (this.closed) return;
    this.slidingBuffer.flush();
    await this.requests;
    if (this.closed) return;
    const failed = this.pendingFailure; this.pendingFailure = false;
    if (failed || !this.lastTranscript) return;
    const event: TranscriptEvent = { ...this.lastTranscript, isFinal: true };
    this.lastTranscript = undefined;
    this.emit('transcript', event);
    if (!this.closed) this.emit('final_transcript', event);
  }

  /** Abort admitted HTTP work and suppress every result after the close boundary. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.lastTranscript = undefined;
    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Internal — chunk transcription
  // -------------------------------------------------------------------------

  /**
   * Transcribe a ready audio chunk by POST-ing it to the Whisper API.
   *
   * Steps:
   * 1. Encode the Float32 chunk as a RIFF/WAV `ArrayBuffer`.
   * 2. Build a multipart/form-data body with the WAV blob.
   * 3. POST to `${baseUrl}/v1/audio/transcriptions`.
   * 4. Parse the `verbose_json` response into a {@link TranscriptEvent}.
   * 5. Emit `'transcript'` and `'interim_transcript'` with the same payload,
   *    and save the text as `previousPrompt`.
   *
   * On any fetch error, `'error'` is emitted and the method returns normally
   * so that subsequent chunks are still processed. After `close()`, an aborted
   * or late response emits nothing.
   *
   * @param chunk - Float32 PCM samples for one audio chunk.
   */
  private async onChunkReady(chunk: Float32Array): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const form = new FormData();
      form.append('file', new Blob([encodeWav(chunk)], { type: 'audio/wav' }), 'chunk.wav');
      form.append('model', this.cfg.model); form.append('response_format', 'verbose_json');
      if (this.cfg.language) form.append('language', this.cfg.language);
      if (this.previousPrompt) form.append('prompt', this.previousPrompt);
      const response = await fetch(`${this.cfg.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, body: form,
      });
      if (!response.ok) throw new Error(`Whisper API error ${response.status}`);
      const json = await response.json() as WhisperTranscriptionResponse;
      if (this.closed || controller.signal.aborted) return;
      const event = this.parseWhisperResponse(json);
      this.previousPrompt = json.text.trim() || this.previousPrompt;
      this.lastTranscript = event;
      this.emit('transcript', event);
      if (!this.closed) this.emit('interim_transcript', event);
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      this.pendingFailure = true;
      this.emit('error', error instanceof Error ? error : new Error('Whisper recognition failed'));
    } finally { this.controllers.delete(controller); }
  }

  /**
   * Convert a Whisper `verbose_json` response into a {@link TranscriptEvent}.
   *
   * Word-level timestamps are sourced from the first segment's `words` array
   * when available.  Confidence is approximated from the segment `avg_logprob`
   * (clamped to [0, 1]) when present; falls back to 1 otherwise.
   *
   * @param response - Parsed Whisper verbose_json response.
   * @returns A `TranscriptEvent` suitable for emission.
   */
  private parseWhisperResponse(response: WhisperTranscriptionResponse): TranscriptEvent {
    const text = response.text.trim();

    // Collect word-level timestamps from all segments.
    const words: TranscriptWord[] = (response.segments ?? []).flatMap(
      (seg: WhisperSegment) =>
        (seg.words ?? []).map((w) => ({
          word: w.word.trim(),
          start: w.start,
          end: w.end,
          confidence: 1, // Whisper word-level confidence not available in verbose_json
        })),
    );

    // Use avg_logprob of the first segment as a proxy for overall confidence.
    const firstSeg = response.segments?.[0];
    const confidence =
      firstSeg?.avg_logprob !== undefined
        ? Math.max(0, Math.min(1, Math.exp(firstSeg.avg_logprob)))
        : 1;

    const durationMs =
      response.duration !== undefined ? Math.round(response.duration * 1000) : undefined;

    return {
      text,
      confidence,
      words,
      isFinal: false, // interim — flush() will emit the final event
      durationMs,
    };
  }
}
