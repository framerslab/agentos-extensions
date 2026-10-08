// @ts-nocheck
/**
 * @file GoogleCloudSTTProvider.ts
 * @description Batch speech-to-text provider backed by Google Cloud Speech-to-Text V1 API.
 *
 * Credentials are resolved from the constructor argument:
 * - If the string contains `/` or `\`, it is treated as a path to a service-account JSON key file
 *   and passed to the client as `keyFilename`.
 * - Otherwise the string is parsed as a JSON object and passed as `credentials`.
 *
 * @module google-cloud-stt
 */

// Dynamic import is used so the SDK is only loaded at runtime, allowing the
// module to load without throwing when the peer dep is absent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechClient = any;

/**
 * One stretch of recognised speech: Google returns a result per consecutive
 * portion of the audio.
 */
export interface SpeechTranscriptionSegment {
  /** The most likely transcript of this stretch. */
  text: string;
  /** Start in seconds from the beginning of the audio. */
  startTime: number;
  /** End in seconds from the beginning of the audio. */
  endTime: number;
  /** Confidence score in [0, 1], when Google reports one. */
  confidence?: number;
}

/**
 * The transcription result of the AgentOS `SpeechToTextProvider` contract
 * (`SpeechTranscriptionResult` in `@framers/agentos`), mirrored here so the
 * pack carries no type import from agentos.
 */
export interface SpeechTranscriptionResult {
  /** The recognised text: every stretch's most likely transcript, in order. */
  text: string;
  /** BCP-47 language of the transcript. */
  language?: string;
  /** Mean confidence of the stretches, in [0, 1], when Google reports any. */
  confidence?: number;
  /** Always `true`: batch recognition returns final results only. */
  isFinal: boolean;
  /** Always 0; cost is tracked above the provider, as for AgentOS's core batch providers. */
  cost: number;
  /** Per-stretch transcripts with their timing, when Google reports end times. */
  segments?: SpeechTranscriptionSegment[];
  /** The raw `RecognizeResponse`. */
  providerResponse?: unknown;
}

/**
 * Per-call transcription options forwarded to the Google Cloud API.
 */
export interface GoogleCloudSTTOptions {
  /** BCP-47 language code (e.g. `'en-US'`, `'fr-FR'`). @defaultValue `'en-US'` */
  language?: string;
}

/**
 * Audio passed to {@link GoogleCloudSTTProvider.transcribe}: the fields of the
 * AgentOS `SpeechAudioInput` this provider reads.
 */
export interface AudioData {
  /** The audio bytes: a WAV or FLAC file, or raw LINEAR16 PCM. */
  data: Buffer;
  /** Sample rate in Hz. Raw PCM defaults to 16000; a WAV or FLAC header supplies its own. */
  sampleRate?: number;
  /** MIME type, such as `'audio/wav'`. Informational: the bytes decide the encoding. */
  mimeType?: string;
  /** Container format, such as `'wav'`. Informational: the bytes decide the encoding. */
  format?: string;
}

/** True when the bytes start with a RIFF/WAVE header. */
function hasWavHeader(data: Buffer): boolean {
  return data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WAVE';
}

/** True when the bytes start with the FLAC stream marker. */
function hasFlacHeader(data: Buffer): boolean {
  return data.length >= 4 && data.toString('latin1', 0, 4) === 'fLaC';
}

/**
 * The encoding fields of the recognition config for this audio.
 *
 * WAV and FLAC files carry a header that states the encoding and sample rate.
 * Google reads both from it and rejects a request whose stated values disagree
 * (google.cloud.speech.v1 `RecognitionConfig`), so for those files the
 * encoding is left out and the sample rate is sent only when the caller gives
 * one. Anything else is sent as raw LINEAR16 PCM.
 *
 * The bytes decide, not the declared type: AgentOS's speech adapter labels
 * every buffer `audio/wav`, headerless PCM included.
 */
function encodingFor(audio: AudioData): { encoding?: string; sampleRateHertz?: number } {
  if (hasWavHeader(audio.data) || hasFlacHeader(audio.data)) {
    return audio.sampleRate ? { sampleRateHertz: audio.sampleRate } : {};
  }
  return { encoding: 'LINEAR16', sampleRateHertz: audio.sampleRate ?? 16000 };
}

/** Seconds in a protobuf `Duration` (`{ seconds, nanos }`, seconds possibly a string). */
function durationSeconds(duration: { seconds?: unknown; nanos?: unknown } | null | undefined): number | undefined {
  if (!duration) return undefined;
  const seconds = Number(duration.seconds ?? 0) + Number(duration.nanos ?? 0) / 1e9;
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Google Cloud Speech-to-Text batch provider.
 *
 * Implements the `SpeechToTextProvider` contract expected by the AgentOS
 * voice pipeline without taking a hard runtime dependency on the interface
 * types (to avoid circular imports when loaded as an extension pack).
 */
export class GoogleCloudSTTProvider {
  /** Stable provider identifier used by the AgentOS extension registry. */
  readonly id = 'google-cloud-stt';

  /** Human-readable provider name. */
  readonly displayName = 'Google Cloud Speech-to-Text';

  /** Batch recognition only: this provider does not stream. */
  readonly supportsStreaming = false;

  /** Lazily initialised Speech client. */
  private _client: SpeechClient | null = null;

  /** Resolved client constructor options (set in constructor, used in {@link _getClient}). */
  private readonly _clientOptions: Record<string, unknown>;

  /**
   * Create a new {@link GoogleCloudSTTProvider}.
   *
   * @param credentials - Either an absolute path to a service-account JSON key
   *   file (any string that contains `/` or `\`), a JSON string containing
   *   the service-account credentials object, or an empty string, which
   *   leaves the client on Google's Application Default Credentials.
   */
  constructor(credentials: string) {
    if (!credentials.trim()) {
      // No key given: the Google client finds Application Default Credentials
      // (GOOGLE_APPLICATION_CREDENTIALS, gcloud, or the metadata server) when
      // it is first used, so the pack still loads without a configured secret.
      this._clientOptions = {};
    } else if (credentials.includes('/') || credentials.includes('\\')) {
      // Treat as a file path.
      this._clientOptions = { keyFilename: credentials };
    } else {
      // Treat as an inline JSON credentials object.
      this._clientOptions = { credentials: JSON.parse(credentials) as Record<string, unknown> };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Return (and lazily create) the Google Cloud {@link SpeechClient}.
   *
   * Using a lazy initialisation pattern keeps the constructor synchronous and
   * allows unit tests to inject the mock before the first `transcribe()` call.
   */
  private async _getClient(): Promise<SpeechClient> {
    if (!this._client) {
      // Dynamic import keeps the peer dep truly optional at module-load time.
      const { SpeechClient } = await import('@google-cloud/speech');
      this._client = new SpeechClient(this._clientOptions);
    }
    return this._client;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * The provider's display name, as the AgentOS speech contract requires.
   *
   * @returns `'Google Cloud Speech-to-Text'`.
   */
  getProviderName(): string {
    return this.displayName;
  }

  /**
   * Transcribe an audio file or raw PCM buffer using Google Cloud Speech-to-Text.
   *
   * Google returns one result per consecutive stretch of the audio, each with
   * its alternatives ordered by likelihood. The transcript is every stretch's
   * first alternative, in order.
   *
   * @param audio   - WAV or FLAC file bytes, or raw LINEAR16 PCM with its sample rate.
   * @param options - Optional per-call parameters (language code).
   * @returns The transcription in the AgentOS `SpeechTranscriptionResult` shape.
   */
  async transcribe(
    audio: AudioData,
    options?: GoogleCloudSTTOptions,
  ): Promise<SpeechTranscriptionResult> {
    const client = await this._getClient();
    const languageCode = options?.language ?? 'en-US';

    const response = await client.recognize({
      audio: { content: audio.data.toString('base64') },
      config: { ...encodingFor(audio), languageCode },
    });
    const recognized = response[0];

    const stretches: Array<{ text: string; confidence?: number; endTime?: number }> = [];
    for (const result of recognized?.results ?? []) {
      const alt = result?.alternatives?.[0];
      if (!alt) continue;
      stretches.push({
        text: (alt.transcript ?? '').trim(),
        confidence: typeof alt.confidence === 'number' ? alt.confidence : undefined,
        endTime: durationSeconds(result.resultEndTime),
      });
    }

    const confidences = stretches.map((s) => s.confidence).filter((c): c is number => c !== undefined);
    // Timing is reported only when Google gives every stretch an end time.
    let start = 0;
    const segments = stretches.length > 0 && stretches.every((s) => s.endTime !== undefined)
      ? stretches.map((s) => {
          const segment = { text: s.text, startTime: start, endTime: s.endTime as number, confidence: s.confidence };
          start = s.endTime as number;
          return segment;
        })
      : undefined;

    return {
      text: stretches.map((s) => s.text).filter((t) => t.length > 0).join(' '),
      language: recognized?.results?.[0]?.languageCode || languageCode,
      confidence: confidences.length > 0 ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length : undefined,
      isFinal: true,
      cost: 0,
      segments,
      providerResponse: recognized,
    };
  }
}
