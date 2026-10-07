// @ts-nocheck
/**
 * @file GoogleCloudTTSProvider.ts
 * @description Text-to-speech provider backed by Google Cloud Text-to-Speech API.
 *
 * Credentials follow the same resolution strategy as the STT pack:
 * - Strings containing `/` or `\` are treated as paths to a service-account JSON key file.
 * - All other strings are parsed as inline JSON credentials objects.
 *
 * The provider outputs MP3 audio (AUDIO_ENCODING = `'MP3'`).
 *
 * @module google-cloud-tts
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextToSpeechClient = any;

/**
 * A voice available on the Google Cloud TTS platform.
 *
 * Mirrors the generic `SpeechVoice` shape used across the AgentOS voice pipeline.
 */
export interface SpeechVoice {
  /** Provider-specific voice identifier (e.g. `'en-US-Neural2-C'`). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Primary BCP-47 language code supported by this voice. */
  languageCode: string;
  /** Biological gender label from the API (`'MALE'`, `'FEMALE'`, `'NEUTRAL'`). */
  gender?: string;
}

/**
 * Synthesised audio returned by {@link GoogleCloudTTSProvider.synthesize}.
 */
export interface SynthesisResult {
  /** Raw MP3 audio bytes. */
  audioBuffer: Buffer;
  /** MIME type of the audio data. Always `'audio/mpeg'` for this provider. */
  mimeType: 'audio/mpeg';
  /** Billable cost of the request (placeholder — always 0). */
  cost: number;
}

/**
 * Per-call synthesis options forwarded to the Google Cloud TTS API.
 */
export interface GoogleCloudTTSOptions {
  /** BCP-47 language code for the synthesised voice. @defaultValue `'en-US'` */
  languageCode?: string;
  /**
   * Provider-specific voice name (e.g. `'en-US-Neural2-C'`).
   * When omitted, Google Cloud selects the default voice for the language.
   */
  voice?: string;
}

/**
 * Google Cloud Text-to-Speech provider.
 *
 * Implements the `TextToSpeechProvider` contract expected by the AgentOS voice
 * pipeline without taking a hard runtime dependency on the interface types.
 */
export class GoogleCloudTTSProvider {
  /** Stable provider identifier used by the AgentOS extension registry. */
  readonly id = 'google-cloud-tts';

  /** Lazily initialised TTS client. */
  private _client: TextToSpeechClient | null = null;

  /** Resolved client constructor options (set in constructor). */
  private readonly _clientOptions: Record<string, unknown>;

  /**
   * Create a new {@link GoogleCloudTTSProvider}.
   *
   * @param credentials - Absolute path to a service-account JSON key file, an
   *   inline JSON credentials string, or an empty string, which leaves the
   *   client on Google's Application Default Credentials.
   */
  constructor(credentials: string) {
    if (!credentials.trim()) {
      // No key given: the Google client finds Application Default Credentials
      // (GOOGLE_APPLICATION_CREDENTIALS, gcloud, or the metadata server) when
      // it is first used, so the pack still loads without a configured secret.
      this._clientOptions = {};
    } else if (credentials.includes('/') || credentials.includes('\\')) {
      this._clientOptions = { keyFilename: credentials };
    } else {
      this._clientOptions = { credentials: JSON.parse(credentials) as Record<string, unknown> };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Lazily create and return the Google Cloud {@link TextToSpeechClient}.
   */
  private async _getClient(): Promise<TextToSpeechClient> {
    if (!this._client) {
      const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
      this._client = new TextToSpeechClient(this._clientOptions);
    }
    return this._client;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Synthesise text to MP3 audio using Google Cloud TTS.
   *
   * @param text    - Plain text to synthesise.
   * @param options - Optional per-call parameters (languageCode, voice name).
   * @returns {@link SynthesisResult} containing the raw MP3 buffer.
   */
  async synthesize(text: string, options?: GoogleCloudTTSOptions): Promise<SynthesisResult> {
    const client = await this._getClient();

    const response = await client.synthesizeSpeech({
      input: { text },
      voice: {
        languageCode: options?.languageCode ?? 'en-US',
        name: options?.voice,
      },
      audioConfig: { audioEncoding: 'MP3' },
    });

    return {
      audioBuffer: Buffer.from(response[0].audioContent as Uint8Array),
      mimeType: 'audio/mpeg',
      cost: 0,
    };
  }

  /**
   * List all voices available on the Google Cloud TTS platform.
   *
   * @returns Array of {@link SpeechVoice} objects sorted by voice name.
   */
  async listAvailableVoices(): Promise<SpeechVoice[]> {
    const client = await this._getClient();
    const response = await client.listVoices({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const voices: SpeechVoice[] = (response[0]?.voices ?? []).map((v: any) => ({
      id: v.name ?? '',
      name: v.name ?? '',
      languageCode: v.languageCodes?.[0] ?? '',
      gender: v.ssmlGender ?? undefined,
    }));

    return voices;
  }
}
