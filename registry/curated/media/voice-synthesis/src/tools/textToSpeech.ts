// @ts-nocheck
/**
 * text_to_speech: speech from text through Deepgram, OpenAI, ElevenLabs or a
 * server that speaks OpenAI's speech API. The audio is saved (see
 * `audioFiles.ts`) and the output carries its URL, never the audio itself:
 * AgentOS sends a tool's output to the model as text, and base64 audio there
 * is hundreds of kilobytes in the next request.
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';

import { audioStore, checkAudioStore, describeError, storeAudio, type AudioStore, type SaveAudio } from '../audioFiles.js';

/** A provider name as a caller gives it; `ollama` is the old name of `openai-compatible`. */
export type TTSProvider = 'auto' | 'deepgram' | 'openai' | 'elevenlabs' | 'openai-compatible' | 'ollama';

/** A provider that runs. */
type Provider = 'deepgram' | 'openai' | 'elevenlabs' | 'openai-compatible';

/** The formats the tool offers. Raw PCM is not one: its bytes carry no signature to check. */
export type TTSFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';

export interface TTSInput {
  text: string;
  provider?: TTSProvider;
  voice?: string;
  model?: string;
  format?: TTSFormat;
  speed?: number;
  /** ElevenLabs only. */
  stability?: number;
  /** ElevenLabs only. */
  similarity_boost?: number;
  /** OpenAI's gpt-4o-mini-tts models, and a compatible server. */
  instructions?: string;
}

export interface TTSOutput {
  /** The saved audio: a `file:` URL, or the http(s) URL of the host's `saveAudio`. */
  audioUrl: string;
  bytes: number;
  contentType: string;
  format: TTSFormat;
  provider: Provider;
  model: string;
  voice: string;
  /** The length of the text spoken, in characters. */
  characters: number;
  durationEstimateMs: number;
  /** Settings given that the provider used does not take, and that were not sent. */
  notSent?: string[];
}

export interface TTSConfig {
  deepgramApiKey?: string;
  /** An API base: requests go to `{base}/speak`. */
  deepgramBaseUrl?: string;
  openaiApiKey?: string;
  /** An API base: requests go to `{base}/audio/speech`. */
  openaiBaseUrl?: string;
  elevenLabsApiKey?: string;
  /** An API base: requests go to `{base}/text-to-speech/{voice_id}`. */
  elevenLabsBaseUrl?: string;
  /** An API base of an OpenAI-compatible speech server: requests go to `{base}/audio/speech`. */
  compatibleBaseUrl?: string;
  compatibleApiKey?: string;
  /** The old option for that server, a server root: requests go to `{root}/v1/audio/speech`. */
  ollamaBaseUrl?: string;
  defaultProvider?: string;
  /** The default saver's directory (see `audioDirectory`). */
  audioDir?: string;
  /** The host's saver, which replaces the default. */
  saveAudio?: SaveAudio;
  /** The most bytes of audio read from one answer. Default 128 MiB. */
  maxAudioBytes?: number;
  /** The deadline of one request, its answer's body included, in milliseconds. Default five minutes. */
  requestTimeoutMs?: number;
}

const PROVIDERS: Provider[] = ['deepgram', 'openai', 'elevenlabs', 'openai-compatible'];
const PROVIDER_NAMES = ['auto', ...PROVIDERS, 'ollama'];

/** OpenAI's built-in voices (openai-node 7.32.0 `resources/audio/speech.d.ts`). */
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

/** ElevenLabs voice names and their ids. */
const ELEVENLABS_VOICES: Record<string, string> = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  domi: 'AZnzlk1XvdvUeBnXmlld',
  bella: 'EXAVITQu4vr4xnSDxMaL',
  antoni: 'ErXwobaYiN019PkySvjV',
  josh: 'TxGEqnHWrfWFTfGW9XjX',
  arnold: 'VR6AewLTigWG4xSOukaG',
  adam: 'pNInz6obpgDQGcFmaJgB',
  sam: 'yoZ06aMxZJJ28mfd3POQ',
};

const DEFAULT_MODELS: Record<Provider, string> = {
  deepgram: 'aura-2-thalia-en',
  openai: 'gpt-4o-mini-tts',
  elevenlabs: 'eleven_multilingual_v2',
  'openai-compatible': 'tts-1',
};

const DEFAULT_VOICES: Record<Exclude<Provider, 'deepgram'>, string> = {
  openai: 'nova',
  elevenlabs: 'rachel',
  'openai-compatible': 'alloy',
};

const DEFAULT_BASE_URLS = {
  deepgram: 'https://api.deepgram.com/v1',
  openai: 'https://api.openai.com/v1',
  elevenlabs: 'https://api.elevenlabs.io/v1',
};

/** The longest text each provider takes, in characters (ElevenLabs: by model; see https://elevenlabs.io/docs/models). */
const TEXT_LIMITS = { openai: 4096, deepgram: 2000 };
const ELEVENLABS_TEXT_LIMITS: Record<string, number> = {
  eleven_v3: 5000,
  eleven_multilingual_v2: 10000,
  eleven_flash_v2_5: 40000,
  eleven_flash_v2: 30000,
};

/** ElevenLabs models served by its Text to Dialogue API, not by the text-to-speech endpoint this tool calls. */
const ELEVENLABS_DIALOGUE_MODELS = ['eleven_v4', 'eleven_v4_turbo'];

/** The speed each provider documents (OpenAI `speech.d.ts`; Deepgram's speak reference). */
const SPEED_RANGES: Partial<Record<Provider, [number, number]>> = {
  openai: [0.25, 4],
  'openai-compatible': [0.25, 4],
  deepgram: [0.7, 1.5],
};

/** How each format is asked of each provider. ElevenLabs makes no AAC or FLAC. */
const FORMATS: Record<
  TTSFormat,
  { openai: string; deepgram: Record<string, string>; elevenlabs?: string }
> = {
  mp3: { openai: 'mp3', deepgram: { encoding: 'mp3' }, elevenlabs: 'mp3_44100_128' },
  opus: { openai: 'opus', deepgram: { encoding: 'opus', container: 'ogg' }, elevenlabs: 'opus_48000_64' },
  aac: { openai: 'aac', deepgram: { encoding: 'aac' } },
  flac: { openai: 'flac', deepgram: { encoding: 'flac' } },
  wav: { openai: 'wav', deepgram: { encoding: 'linear16', container: 'wav' }, elevenlabs: 'wav_24000' },
};

const DEFAULT_MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** How much of a provider's error body is read, and how much of it is shown. */
const ERROR_BODY_BYTES = 4096;
const ERROR_TEXT_LENGTH = 300;

/**
 * The container `bytes` start as, among those the asked format comes in,
 * with its content type and file extension; `undefined` when they start as
 * none of them, such as an error page sent with status 200.
 */
export function audioContainer(format: TTSFormat, bytes: Buffer): { contentType: string; ext: string } | undefined {
  const starts = (text: string, at = 0) => bytes.length >= at + text.length && bytes.toString('latin1', at, at + text.length) === text;
  const id3 = starts('ID3');
  // An MPEG audio frame starts with 11 set bits; ADTS (AAC) with 12, then layer bits 00.
  const frameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  const adts = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  switch (format) {
    case 'mp3':
      return id3 || frameSync ? { contentType: 'audio/mpeg', ext: 'mp3' } : undefined;
    case 'aac':
      if (id3 || adts) return { contentType: 'audio/aac', ext: 'aac' };
      return starts('ftyp', 4) ? { contentType: 'audio/mp4', ext: 'm4a' } : undefined;
    case 'opus':
      if (starts('OggS')) return { contentType: 'audio/ogg', ext: 'ogg' };
      return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3 ? { contentType: 'audio/webm', ext: 'webm' } : undefined;
    case 'flac':
      return starts('fLaC') ? { contentType: 'audio/flac', ext: 'flac' } : undefined;
    case 'wav':
      return starts('RIFF') && starts('WAVE', 8) ? { contentType: 'audio/wav', ext: 'wav' } : undefined;
    default:
      return undefined;
  }
}

/** An API base or server root without its trailing slashes. */
function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/** A string given and not blank, trimmed; else `undefined`. */
function present(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A limit option: a positive safe integer, or the default when not given. */
function limitOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`voice-synthesis: ${name} must be a positive whole number, not ${JSON.stringify(value) ?? String(value)}.`);
  }
  return value;
}

/** A request's failure that carries a message meant for the caller. */
class TTSError extends Error {}

export class TextToSpeechTool implements ITool<TTSInput, TTSOutput> {
  readonly id = 'tts-multi-provider-v1';
  readonly name = 'text_to_speech';
  readonly displayName = 'Text to Speech';
  readonly description =
    "Speak text: makes an audio file of it with Deepgram, OpenAI or ElevenLabs (or an OpenAI-compatible speech server) and returns the file's URL in audioUrl, never the audio itself. " +
    'With provider auto, a voice name picks its provider (OpenAI: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar; ' +
    'ElevenLabs: rachel, domi, bella, antoni, josh, arnold, adam, sam; Deepgram: an aura- model id such as aura-2-thalia-en); ' +
    'otherwise Deepgram, then OpenAI, then ElevenLabs, whichever has a key.';
  readonly category = 'media';
  readonly version = '3.0.0';
  // One new file in a directory private to the service's user, never an
  // overwrite. In a host with hitl.requireApprovalForSideEffects the flag
  // would put every call behind approval.
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The text to speak. Text longer than the provider takes (OpenAI 4,096 characters, Deepgram 2,000, ElevenLabs 5,000 to 40,000 by model) is refused, not cut.',
      },
      provider: {
        type: 'string',
        enum: PROVIDER_NAMES,
        description: 'auto (default): the provider a voice name belongs to, else Deepgram, OpenAI, ElevenLabs, whichever has a key.',
      },
      voice: {
        type: 'string',
        description:
          'OpenAI: alloy, ash, ballad, coral, echo, fable, onyx, nova (default), sage, shimmer, verse, marin, cedar, or a custom voice id. ' +
          'ElevenLabs: rachel (default), domi, bella, antoni, josh, arnold, adam, sam, or a voice id. ' +
          'Deepgram: an Aura model id such as aura-2-thalia-en (default), or a voice name such as thalia.',
      },
      model: {
        type: 'string',
        description:
          'Deepgram: an Aura model (default aura-2-thalia-en). OpenAI: gpt-4o-mini-tts (default), tts-1-hd. ' +
          'ElevenLabs: eleven_multilingual_v2 (default), eleven_v3, eleven_flash_v2_5, eleven_flash_v2.',
      },
      format: {
        type: 'string',
        enum: Object.keys(FORMATS),
        description: 'mp3 (default), opus, aac, flac or wav. ElevenLabs makes no aac or flac.',
      },
      speed: { type: 'number', description: 'Speaking rate: OpenAI 0.25 to 4, Deepgram 0.7 to 1.5, ElevenLabs around 1.' },
      stability: { type: 'number', minimum: 0, maximum: 1, description: 'ElevenLabs only: voice stability, 0 to 1.' },
      similarity_boost: { type: 'number', minimum: 0, maximum: 1, description: 'ElevenLabs only: similarity boost, 0 to 1.' },
      instructions: { type: 'string', description: "OpenAI's gpt-4o-mini-tts only: how to speak, such as 'warm and unhurried'." },
    },
    required: ['text'],
  };

  readonly requiredCapabilities = ['capability:tts'];

  private readonly config: TTSConfig;
  private readonly store: AudioStore;
  private readonly maxAudioBytes: number;
  private readonly requestTimeoutMs: number;

  /**
   * @throws When `maxAudioBytes` or `requestTimeoutMs` is given and is not a
   *   positive whole number.
   */
  constructor(config?: TTSConfig) {
    this.config = {
      ...config,
      deepgramApiKey: config?.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '',
      deepgramBaseUrl: base(config?.deepgramBaseUrl || process.env.DEEPGRAM_BASE_URL || DEFAULT_BASE_URLS.deepgram),
      openaiApiKey: config?.openaiApiKey || process.env.OPENAI_API_KEY || '',
      openaiBaseUrl: base(config?.openaiBaseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URLS.openai),
      elevenLabsApiKey: config?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '',
      elevenLabsBaseUrl: base(config?.elevenLabsBaseUrl || DEFAULT_BASE_URLS.elevenlabs),
      compatibleBaseUrl: present(config?.compatibleBaseUrl) ? base(config.compatibleBaseUrl.trim()) : undefined,
      compatibleApiKey: config?.compatibleApiKey || '',
      ollamaBaseUrl: present(config?.ollamaBaseUrl || process.env.OLLAMA_BASE_URL)
        ? base((config?.ollamaBaseUrl || process.env.OLLAMA_BASE_URL).trim())
        : undefined,
      defaultProvider: config?.defaultProvider || process.env.TTS_PROVIDER || 'auto',
    };
    this.store = audioStore({ audioDir: config?.audioDir, saveAudio: config?.saveAudio });
    this.maxAudioBytes = limitOption('maxAudioBytes', config?.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES);
    this.requestTimeoutMs = limitOption('requestTimeoutMs', config?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async execute(args: TTSInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<TTSOutput>> {
    try {
      return { success: true, output: await this.speak(args ?? ({} as TTSInput), context) };
    } catch (error) {
      return { success: false, error: this.redact(describeError(error)) };
    }
  }

  /** `text` with every configured key replaced, so an error that echoes a request cannot pass a key on. */
  private redact(text: string): string {
    let out = text;
    for (const key of [this.config.deepgramApiKey, this.config.openaiApiKey, this.config.elevenLabsApiKey, this.config.compatibleApiKey]) {
      if (typeof key === 'string' && key.length >= 6) out = out.split(key).join('[redacted]');
    }
    return out;
  }

  /** Whether a provider can run: its key, or for the compatible server a base URL. */
  private configured(provider: Provider): boolean {
    switch (provider) {
      case 'deepgram':
        return Boolean(this.config.deepgramApiKey);
      case 'openai':
        return Boolean(this.config.openaiApiKey);
      case 'elevenlabs':
        return Boolean(this.config.elevenLabsApiKey);
      case 'openai-compatible':
        return Boolean(this.config.compatibleBaseUrl || this.config.ollamaBaseUrl);
    }
  }

  /** What a provider needs, for a refusal. */
  private static needs(provider: Provider): string {
    switch (provider) {
      case 'deepgram':
        return 'DEEPGRAM_API_KEY or the secret deepgram.apiKey';
      case 'openai':
        return 'OPENAI_API_KEY or the secret openai.apiKey';
      case 'elevenlabs':
        return 'ELEVENLABS_API_KEY or the secret elevenlabs.apiKey';
      case 'openai-compatible':
        return 'the pack option compatibleBaseUrl (or ollamaBaseUrl, or OLLAMA_BASE_URL)';
    }
  }

  /**
   * The provider of a call: the one named, else under `auto` the one the
   * voice belongs to, else the first with a key of Deepgram, OpenAI and
   * ElevenLabs. Never another provider than the one named.
   */
  private provider(requested: unknown, voice: string | undefined): Provider {
    const asked = requested === undefined || requested === null ? this.config.defaultProvider : requested;
    if (typeof asked !== 'string' || !PROVIDER_NAMES.includes(asked)) {
      throw new TTSError(`provider must be one of ${PROVIDER_NAMES.join(', ')}, not ${JSON.stringify(asked) ?? String(asked)}.`);
    }
    const name = (asked === 'ollama' ? 'openai-compatible' : asked) as Provider | 'auto';
    if (name !== 'auto') {
      if (!this.configured(name)) throw new TTSError(`provider ${name} needs ${TextToSpeechTool.needs(name)}.`);
      return name;
    }
    const lower = voice?.toLowerCase();
    const owner: Provider | undefined = lower
      ? OPENAI_VOICES.includes(lower)
        ? 'openai'
        : Object.hasOwn(ELEVENLABS_VOICES, lower)
          ? 'elevenlabs'
          : /^aura-/.test(lower)
            ? 'deepgram'
            : undefined
      : undefined;
    if (owner) {
      if (!this.configured(owner)) {
        throw new TTSError(`voice ${voice} is a voice of ${owner}, and provider ${owner} needs ${TextToSpeechTool.needs(owner)}.`);
      }
      return owner;
    }
    const first = (['deepgram', 'openai', 'elevenlabs'] as Provider[]).find((candidate) => this.configured(candidate));
    if (!first) {
      throw new TTSError(
        'No text-to-speech provider is set up: set DEEPGRAM_API_KEY, OPENAI_API_KEY or ELEVENLABS_API_KEY (or the secrets deepgram.apiKey, openai.apiKey, elevenlabs.apiKey), or name provider openai-compatible with a compatibleBaseUrl.',
      );
    }
    return first;
  }

  private async speak(args: TTSInput, context?: ToolExecutionContext): Promise<TTSOutput> {
    // The arguments, checked before anything is called.
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new TTSError('text must be a string with something to speak.');
    const text = args.text;
    const characters = Array.from(text).length;
    for (const field of ['voice', 'model', 'instructions'] as const) {
      if (args[field] !== undefined && (typeof args[field] !== 'string' || (field !== 'instructions' && args[field].trim() === ''))) {
        throw new TTSError(`${field} must be a ${field === 'instructions' ? 'string' : 'non-empty string'}.`);
      }
    }
    for (const field of ['speed', 'stability', 'similarity_boost'] as const) {
      if (args[field] !== undefined && (typeof args[field] !== 'number' || !Number.isFinite(args[field]))) {
        throw new TTSError(`${field} must be a finite number.`);
      }
    }
    for (const field of ['stability', 'similarity_boost'] as const) {
      if (args[field] !== undefined && (args[field] < 0 || args[field] > 1)) throw new TTSError(`${field} must be between 0 and 1.`);
    }
    const format = args.format ?? 'mp3';
    if (typeof format !== 'string' || !Object.hasOwn(FORMATS, format)) {
      throw new TTSError(`format must be one of ${Object.keys(FORMATS).join(', ')}.`);
    }

    const voiceArg = present(args.voice);
    const provider = this.provider(args.provider, voiceArg);
    const model = present(args.model) ?? (provider === 'deepgram' && voiceArg ? deepgramModel(voiceArg) : DEFAULT_MODELS[provider]);
    // Deepgram's voice is its model; an OpenAI built-in goes in lower case, as OpenAI names it.
    let voice = provider === 'deepgram' ? model : (voiceArg ?? DEFAULT_VOICES[provider]);
    if (provider === 'openai' && OPENAI_VOICES.includes(voice.toLowerCase())) voice = voice.toLowerCase();

    if (provider === 'elevenlabs' && ELEVENLABS_DIALOGUE_MODELS.includes(model)) {
      throw new TTSError(`${model} is served by ElevenLabs' Text to Dialogue API, which this tool does not call: use eleven_multilingual_v2, eleven_v3, eleven_flash_v2_5 or eleven_flash_v2.`);
    }
    const limit =
      provider === 'elevenlabs'
        ? Object.hasOwn(ELEVENLABS_TEXT_LIMITS, model)
          ? ELEVENLABS_TEXT_LIMITS[model]
          : undefined
        : TEXT_LIMITS[provider];
    if (limit !== undefined && characters > limit) {
      throw new TTSError(`text is ${characters} characters, and ${provider}${provider === 'elevenlabs' ? ` ${model}` : ''} takes at most ${limit}.`);
    }
    if (provider === 'elevenlabs' && !FORMATS[format].elevenlabs) {
      throw new TTSError(`ElevenLabs makes no ${format}: use mp3, opus or wav.`);
    }
    const range = SPEED_RANGES[provider];
    if (args.speed !== undefined && range && (args.speed < range[0] || args.speed > range[1])) {
      throw new TTSError(`speed for ${provider} must be between ${range[0]} and ${range[1]}.`);
    }

    const takesInstructions = provider === 'openai-compatible' || (provider === 'openai' && model.startsWith('gpt-4o-mini-tts'));
    const notSent = [
      ...(provider !== 'elevenlabs' ? (['stability', 'similarity_boost'] as const).filter((field) => args[field] !== undefined) : []),
      ...(args.instructions !== undefined && !takesInstructions ? ['instructions'] : []),
    ];

    // A directory the default saver would refuse costs no synthesis.
    await checkAudioStore(this.store, context);

    const { url, init } = this.request(provider, { text, model, voice, format, args, takesInstructions });
    const bytes = await this.fetchAudio(provider, url, init);
    if (bytes.length === 0) throw new TTSError(`${provider} answered with no audio.`);
    const container = audioContainer(format, bytes);
    if (!container) throw new TTSError(`${provider}'s answer is not ${format} audio, so it was not saved.`);

    const audioUrl = await storeAudio(bytes, container, this.name, this.store, context);
    return {
      audioUrl,
      bytes: bytes.length,
      contentType: container.contentType,
      format,
      provider,
      model,
      voice,
      characters,
      durationEstimateMs: Math.round((text.trim().split(/\s+/).length / 150) * 60 * 1000),
      ...(notSent.length ? { notSent } : {}),
    };
  }

  /** The URL and request of a provider's speech call. Only the fields each provider documents are sent. */
  private request(
    provider: Provider,
    call: { text: string; model: string; voice: string; format: TTSFormat; args: TTSInput; takesInstructions: boolean },
  ): { url: string; init: RequestInit } {
    const { text, model, voice, format, args, takesInstructions } = call;
    const json = { 'Content-Type': 'application/json' };
    switch (provider) {
      case 'deepgram': {
        // No callback parameter, ever: Deepgram would post the audio to that URL.
        const query = new URLSearchParams({ model, ...FORMATS[format].deepgram });
        if (args.speed !== undefined) query.set('speed', String(args.speed));
        return {
          url: `${this.config.deepgramBaseUrl}/speak?${query.toString()}`,
          init: { method: 'POST', headers: { ...json, Authorization: `Token ${this.config.deepgramApiKey}` }, body: JSON.stringify({ text }) },
        };
      }
      case 'elevenlabs': {
        const lower = voice.toLowerCase();
        const voiceId = Object.hasOwn(ELEVENLABS_VOICES, lower) ? ELEVENLABS_VOICES[lower] : voice;
        const settings = {
          stability: args.stability ?? 0.5,
          similarity_boost: args.similarity_boost ?? 0.75,
          ...(args.speed !== undefined ? { speed: args.speed } : {}),
        };
        return {
          url: `${this.config.elevenLabsBaseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${FORMATS[format].elevenlabs}`,
          init: {
            method: 'POST',
            headers: { ...json, 'xi-api-key': this.config.elevenLabsApiKey },
            body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
          },
        };
      }
      default: {
        // OpenAI, and a server that speaks its API.
        const compatible = provider === 'openai-compatible';
        const body = {
          model,
          // A voice OpenAI does not build in goes as a custom voice, by its id.
          voice: compatible || OPENAI_VOICES.includes(voice) ? voice : { id: voice },
          input: text,
          response_format: FORMATS[format].openai,
          ...(args.speed !== undefined ? { speed: args.speed } : {}),
          ...(args.instructions !== undefined && takesInstructions ? { instructions: args.instructions } : {}),
        };
        const key = compatible ? this.config.compatibleApiKey : this.config.openaiApiKey;
        const url = !compatible
          ? `${this.config.openaiBaseUrl}/audio/speech`
          : this.config.compatibleBaseUrl
            ? `${this.config.compatibleBaseUrl}/audio/speech`
            : `${this.config.ollamaBaseUrl}/v1/audio/speech`;
        return {
          url,
          init: { method: 'POST', headers: { ...json, ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) },
        };
      }
    }
  }

  /**
   * The audio of a provider's answer, read within the deadline and at most
   * `maxAudioBytes`. An error answer fails with its status and the start of
   * its body; an answer cut off by the connection fails in the read.
   */
  private async fetchAudio(provider: Provider, url: string, init: RequestInit): Promise<Buffer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = (await readBody(response, ERROR_BODY_BYTES, false, provider)).toString('utf8').slice(0, ERROR_TEXT_LENGTH);
        throw new TTSError(`${provider} refused the request (${response.status}): ${body}`);
      }
      return await readBody(response, this.maxAudioBytes, true, provider);
    } catch (error) {
      if (timedOut) throw new TTSError(`${provider} took longer than ${this.requestTimeoutMs} ms (requestTimeoutMs), so the request was stopped.`);
      if (error instanceof TTSError) throw error;
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      throw new TTSError(`${provider} request failed: ${describeError(error)}${cause ? ` (${cause.code ?? cause.message})` : ''}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

/** A Deepgram model for a voice: an Aura model id as it is, a bare name as an Aura-2 English voice. */
function deepgramModel(voice: string): string {
  return /^aura-/i.test(voice) ? voice : `aura-2-${voice.toLowerCase()}-en`;
}

/**
 * A response's body, read as a stream: at most `limit` bytes. Past the limit
 * an audio answer is refused (`refuse`), and an error body is cut there.
 */
async function readBody(response: Response, limit: number, refuse: boolean, provider: string): Promise<Buffer> {
  if (!response.body) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > limit && refuse) throw new TTSError(`${provider}'s answer is larger than ${limit} bytes (maxAudioBytes), so it was not saved.`);
    return whole.subarray(0, limit);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (total + chunk.length > limit) {
        if (refuse) throw new TTSError(`${provider}'s answer is larger than ${limit} bytes (maxAudioBytes), so it was not saved.`);
        chunks.push(chunk.subarray(0, limit - total));
        total = limit;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}
