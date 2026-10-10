// @ts-nocheck
/**
 * @file GoogleCloudTTSProvider.ts
 * @description Text-to-speech provider backed by Google Cloud Text-to-Speech API.
 *
 * Credentials follow the same rules as the STT pack (see `clientOptionsFor`):
 * - An empty string leaves the client on Application Default Credentials.
 * - A JSON object is an inline service-account key.
 * - Any other string is the path of a service-account key file, when a file
 *   is there; a value that is neither is refused.
 *
 * The provider outputs MP3 audio (AUDIO_ENCODING = `'MP3'`).
 *
 * @module google-cloud-tts
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextToSpeechClient = any;

/**
 * A voice available on the Google Cloud TTS platform, in the AgentOS
 * `SpeechVoice` shape (`id`, `name`, `lang`, `provider`, `gender`).
 */
export interface SpeechVoice {
  /** Provider-specific voice identifier (e.g. `'en-US-Neural2-C'`). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Primary BCP-47 language code supported by this voice (AgentOS `SpeechVoice.lang`). */
  lang: string;
  /** The same code under the name earlier releases of this pack used. */
  languageCode: string;
  /** The provider id, `'google-cloud-tts'`. */
  provider: string;
  /** `'male'`, `'female'` or `'neutral'`, from the API's SSML gender. */
  gender?: string;
}

/** The API's SSML gender as AgentOS names it; unspecified genders are left out. */
function genderOf(ssmlGender: unknown): string | undefined {
  const gender = typeof ssmlGender === 'string' ? ssmlGender.toLowerCase() : '';
  return gender === 'male' || gender === 'female' || gender === 'neutral' ? gender : undefined;
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
 * Client options for a credentials string, decided by its content:
 * - empty or blank: none, so the client finds Application Default Credentials;
 * - a JSON object (`{`, then `"` or `}`): an inline service-account key,
 *   passed as `credentials`;
 * - anything else, `{keys}/sa.json` included: a path to a key file, passed as
 *   `keyFilename` when a file is there.
 *
 * Every real key holds `/` (its https URLs) and `\` (the `\n` escapes in
 * `private_key`), so those characters cannot tell a key from a path. A value
 * that is neither is refused at once: a malformed inline key (its quotes
 * escaped, as a .env file can leave them, a double-encoded string, base64)
 * passed on as a path would have the client open a file by that name at the
 * first call, and the error would carry the key in its message.
 *
 * @throws When the string opens like a JSON object but is not valid JSON, or
 *   is not one and names no file. The message names GOOGLE_CLOUD_TTS_CREDENTIALS and quotes
 *   none of the value.
 */
function clientOptionsFor(credentials: string): Record<string, unknown> {
  const text = credentials.trim();
  if (!text) return {};
  if (/^\{\s*["}]/.test(text)) return { credentials: parseKey(text) };
  // The client opens the file at its first call, so a relative path is fixed
  // to the folder it was checked in.
  if (isFile(text)) return { keyFilename: resolve(text) };
  throw new Error(
    'GOOGLE_CLOUD_TTS_CREDENTIALS is neither a service-account key as a JSON object nor the path of an existing file: give the whole key, or the path to its file.',
  );
}

/**
 * The service-account key in `text`, a JSON object. A key that a .env file
 * gave in double quotes has its `\n` escapes turned into line breaks, which
 * JSON does not allow inside a string, so a key that does not parse is tried
 * once more with the line breaks inside its strings written as `\n`.
 *
 * @throws When neither parses. The message quotes none of the value: JSON.parse's
 *   message quotes the text near the error, and here that text is key material.
 */
function parseKey(text: string): Record<string, unknown> {
  for (const candidate of [text, escapeLineBreaksInStrings(text)]) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Try the next form; the error below names the secret instead.
    }
  }
  throw new Error(
    'GOOGLE_CLOUD_TTS_CREDENTIALS starts with "{" but is not valid JSON: give the whole service-account key, or a path to its file.',
  );
}

/**
 * `text` with each line break inside a JSON string written as `\n`. A line
 * break between tokens, as in a pretty-printed key, is JSON whitespace and
 * stays.
 */
function escapeLineBreaksInStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString && char === '\\') {
      // An escape: the next character belongs to it, a quote included.
      out += char + (text[i + 1] ?? '');
      i += 1;
    } else if (inString && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      out += '\\n';
    } else {
      if (char === '"') inString = !inString;
      out += char;
    }
  }
  return out;
}

/**
 * Whether a file is at `path`. Every failure counts as no: the error of a
 * name too long for the file system quotes the name, which here may be key
 * material.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

  /** Human-readable provider name. */
  readonly displayName = 'Google Cloud Text-to-Speech';

  /** Each request returns the whole clip: this provider does not stream. */
  readonly supportsStreaming = false;

  /** Lazily initialised TTS client. */
  private _client: TextToSpeechClient | null = null;

  /** Resolved client constructor options (set in constructor). */
  private readonly _clientOptions: Record<string, unknown>;

  /**
   * Create a new {@link GoogleCloudTTSProvider}.
   *
   * @param credentials - The service-account key as a JSON object, a path to
   *   its key file, or an empty string, which leaves the client on Google's
   *   Application Default Credentials.
   * @throws When `credentials` opens like a JSON object but is not valid JSON, or
   *   is not one and names no file.
   */
  constructor(credentials: string) {
    // An empty string gives no options: the Google client finds Application
    // Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, gcloud, or the
    // metadata server) when it is first used, so the pack still loads without
    // a configured secret.
    this._clientOptions = clientOptionsFor(credentials);
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
   * The provider's display name, as the AgentOS speech contract requires.
   *
   * @returns `'Google Cloud Text-to-Speech'`.
   */
  getProviderName(): string {
    return this.displayName;
  }

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
      lang: v.languageCodes?.[0] ?? '',
      languageCode: v.languageCodes?.[0] ?? '',
      provider: this.id,
      gender: genderOf(v.ssmlGender),
    }));

    return voices;
  }
}
