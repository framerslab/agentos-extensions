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
 * A single recognised audio segment returned by the provider.
 *
 * Mirrors the generic `SpeechTranscriptionResult` shape used across the
 * AgentOS voice pipeline.
 */
export interface SpeechTranscriptionResult {
  /** The recognised text. */
  transcript: string;
  /** Confidence score in [0, 1]. */
  confidence: number;
  /** Whether this is a final (non-speculative) result. Always `true` for batch. */
  isFinal: boolean;
}

/**
 * Per-call transcription options forwarded to the Google Cloud API.
 */
export interface GoogleCloudSTTOptions {
  /** BCP-47 language code (e.g. `'en-US'`, `'fr-FR'`). @defaultValue `'en-US'` */
  language?: string;
}

/**
 * Audio frame passed to {@link GoogleCloudSTTProvider.transcribe}.
 */
export interface AudioData {
  /** Raw PCM bytes (LINEAR16). */
  data: Buffer;
  /** Sample rate in Hz. @defaultValue `16000` */
  sampleRate?: number;
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
   * Transcribe a batch audio buffer using Google Cloud Speech-to-Text.
   *
   * The audio must be encoded as LINEAR16 (raw PCM, 16-bit little-endian).
   * The method returns all recognised alternatives from the first result, each
   * mapped to a {@link SpeechTranscriptionResult}.
   *
   * @param audio   - Audio frame containing the raw PCM bytes and sample rate.
   * @param options - Optional per-call parameters (language code).
   * @returns Array of transcription results ordered by confidence (descending).
   */
  async transcribe(
    audio: AudioData,
    options?: GoogleCloudSTTOptions,
  ): Promise<SpeechTranscriptionResult[]> {
    const client = await this._getClient();

    const response = await client.recognize({
      audio: { content: audio.data.toString('base64') },
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: audio.sampleRate ?? 16000,
        languageCode: options?.language ?? 'en-US',
      },
    });

    const results: SpeechTranscriptionResult[] = [];

    for (const result of response[0]?.results ?? []) {
      const alt = result?.alternatives?.[0];
      if (alt) {
        results.push({
          transcript: alt.transcript ?? '',
          confidence: alt.confidence ?? 0,
          isFinal: true,
        });
      }
    }

    return results;
  }
}
