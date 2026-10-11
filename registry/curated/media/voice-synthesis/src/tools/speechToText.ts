// @ts-nocheck
/**
 * Multi-provider STT Tool — speech-to-text transcription.
 *
 * Supports: OpenAI Whisper, Deepgram, and Whisper-local/OpenAI-compatible
 * local runtimes behind one stable tool contract.
 */

import type {
  ITool,
  JSONSchemaObject,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@framers/agentos';

export type STTProvider = 'openai' | 'deepgram' | 'whisper-local' | 'auto';
export type STTResponseFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

export interface STTInput {
  audioBase64?: string;
  audioUrl?: string;
  mimeType?: string;
  fileName?: string;
  format?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: STTResponseFormat;
  provider?: STTProvider;
  model?: string;
  diarize?: boolean;
  utterances?: boolean;
  smartFormat?: boolean;
  detectLanguage?: boolean;
  providerOptions?: Record<string, unknown>;
}

export interface STTWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: string | number;
}

export interface STTSegment {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: string | number;
  words?: STTWord[];
}

export interface STTOutput {
  text: string;
  provider: Exclude<STTProvider, 'auto'>;
  model: string;
  language?: string;
  confidence?: number;
  durationSeconds?: number;
  segments?: STTSegment[];
  providerResponse?: unknown;
}

export interface STTConfig {
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  deepgramApiKey?: string;
  deepgramBaseUrl?: string;
  whisperLocalBaseUrl?: string;
  defaultProvider?: STTProvider;
}

interface PreparedAudio {
  data: Buffer;
  mimeType: string;
  format: string;
  fileName: string;
}

interface SttBackend {
  readonly provider: Exclude<STTProvider, 'auto'>;
  isConfigured(config: ResolvedSttConfig): boolean;
  transcribe(
    audio: PreparedAudio,
    input: STTInput,
    config: ResolvedSttConfig,
  ): Promise<STTOutput>;
}

interface ResolvedSttConfig {
  openaiApiKey?: string;
  openaiBaseUrl: string;
  deepgramApiKey?: string;
  deepgramBaseUrl: string;
  whisperLocalBaseUrl?: string;
  defaultProvider: STTProvider;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';
const DEFAULT_WHISPER_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function extensionFromMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/flac':
      return 'flac';
    case 'audio/wav':
    case 'audio/x-wav':
    default:
      return 'wav';
  }
}

function normalizeBase64Input(input: string): { data: Buffer; mimeType?: string } {
  const trimmed = input.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      data: Buffer.from(dataUrlMatch[2], 'base64'),
    };
  }

  return {
    data: Buffer.from(trimmed, 'base64'),
  };
}

function normalizeOpenAiSegments(input: unknown): STTSegment[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const segments = input
    .filter((segment) => typeof segment === 'object' && segment !== null)
    .map((segment) => {
      const value = segment as Record<string, unknown>;
      const words = Array.isArray(value.words)
        ? value.words
            .filter((word) => typeof word === 'object' && word !== null)
            .map((word) => {
              const item = word as Record<string, unknown>;
              return {
                word:
                  typeof item.word === 'string'
                    ? item.word
                    : typeof item.text === 'string'
                      ? item.text
                      : '',
                start: typeof item.start === 'number' ? item.start : 0,
                end: typeof item.end === 'number' ? item.end : 0,
                confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
                speaker:
                  typeof item.speaker === 'string' || typeof item.speaker === 'number'
                    ? item.speaker
                    : undefined,
              };
            })
        : undefined;

      return {
        text: typeof value.text === 'string' ? value.text : '',
        start: typeof value.start === 'number' ? value.start : 0,
        end: typeof value.end === 'number' ? value.end : 0,
        confidence: typeof value.confidence === 'number' ? value.confidence : undefined,
        speaker:
          typeof value.speaker === 'string' || typeof value.speaker === 'number'
            ? value.speaker
            : undefined,
        words,
      };
    })
    .filter((segment) => segment.text || segment.end > segment.start);

  return segments.length > 0 ? segments : undefined;
}

function buildOpenAiFormData(audio: PreparedAudio, input: STTInput, model: string): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([Uint8Array.from(audio.data)], { type: audio.mimeType }),
    audio.fileName,
  );
  form.append('model', model);
  form.append('response_format', input.responseFormat ?? 'verbose_json');
  if (input.language) form.append('language', input.language);
  if (input.prompt) form.append('prompt', input.prompt);
  if (typeof input.temperature === 'number') {
    form.append('temperature', String(input.temperature));
  }
  return form;
}

async function parseOpenAiLikeResponse(
  response: Response,
  input: STTInput,
  provider: 'openai' | 'whisper-local',
  model: string,
): Promise<STTOutput> {
  const responseFormat = input.responseFormat ?? 'verbose_json';
  const contentType = response.headers.get('content-type') ?? '';

  if (responseFormat === 'text' || contentType.includes('text/plain')) {
    const text = await response.text();
    return {
      text,
      provider,
      model,
      language: input.language,
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    provider,
    model,
    language: typeof payload.language === 'string' ? payload.language : input.language,
    durationSeconds:
      typeof payload.duration === 'number'
        ? payload.duration
        : typeof payload.duration_seconds === 'number'
          ? payload.duration_seconds
          : undefined,
    segments: normalizeOpenAiSegments(payload.segments),
    providerResponse: payload,
  };
}

function normalizeDeepgramWords(input: unknown): STTWord[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const words = input
    .filter((word) => typeof word === 'object' && word !== null)
    .map((word) => {
      const value = word as Record<string, unknown>;
      return {
        word:
          typeof value.punctuated_word === 'string'
            ? value.punctuated_word
            : typeof value.word === 'string'
              ? value.word
              : '',
        start: typeof value.start === 'number' ? value.start : 0,
        end: typeof value.end === 'number' ? value.end : 0,
        confidence: typeof value.confidence === 'number' ? value.confidence : undefined,
        speaker:
          typeof value.speaker === 'string' || typeof value.speaker === 'number'
            ? value.speaker
            : undefined,
      };
    })
    .filter((word) => word.word.length > 0);

  return words.length > 0 ? words : undefined;
}

function normalizeDeepgramSegments(payload: Record<string, unknown>): STTSegment[] | undefined {
  const results =
    typeof payload.results === 'object' && payload.results !== null
      ? (payload.results as Record<string, unknown>)
      : undefined;

  if (results && Array.isArray(results.utterances) && results.utterances.length > 0) {
    const utterances = results.utterances
      .filter((utterance) => typeof utterance === 'object' && utterance !== null)
      .map((utterance) => {
        const value = utterance as Record<string, unknown>;
        return {
          text: typeof value.transcript === 'string' ? value.transcript : '',
          start: typeof value.start === 'number' ? value.start : 0,
          end: typeof value.end === 'number' ? value.end : 0,
          confidence: typeof value.confidence === 'number' ? value.confidence : undefined,
          speaker:
            typeof value.speaker === 'string' || typeof value.speaker === 'number'
              ? value.speaker
              : undefined,
          words: normalizeDeepgramWords(value.words),
        };
      })
      .filter((segment) => segment.text.length > 0);

    return utterances.length > 0 ? utterances : undefined;
  }

  const channels = results?.channels;
  if (!Array.isArray(channels) || channels.length === 0) return undefined;
  const firstChannel = channels[0];
  if (typeof firstChannel !== 'object' || firstChannel === null) return undefined;
  const alternatives = (firstChannel as Record<string, unknown>).alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return undefined;
  const firstAlt = alternatives[0];
  if (typeof firstAlt !== 'object' || firstAlt === null) return undefined;

  const alt = firstAlt as Record<string, unknown>;
  const words = normalizeDeepgramWords(alt.words);
  const start = words?.[0]?.start ?? 0;
  const end = words?.[words.length - 1]?.end ?? 0;
  const text = typeof alt.transcript === 'string' ? alt.transcript : '';
  if (!text) return undefined;

  return [
    {
      text,
      start,
      end,
      confidence: typeof alt.confidence === 'number' ? alt.confidence : undefined,
      words,
    },
  ];
}

class OpenAiBackend implements SttBackend {
  readonly provider = 'openai' as const;

  isConfigured(config: ResolvedSttConfig): boolean {
    return Boolean(config.openaiApiKey);
  }

  async transcribe(audio: PreparedAudio, input: STTInput, config: ResolvedSttConfig): Promise<STTOutput> {
    const model = input.model || 'whisper-1';
    const response = await fetch(
      `${stripTrailingSlash(config.openaiBaseUrl)}/audio/transcriptions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey!}`,
        },
        body: buildOpenAiFormData(audio, input, model),
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`OpenAI Whisper transcription failed (${response.status}): ${message}`);
    }

    return parseOpenAiLikeResponse(response, input, 'openai', model);
  }
}

class WhisperLocalBackend implements SttBackend {
  readonly provider = 'whisper-local' as const;

  isConfigured(config: ResolvedSttConfig): boolean {
    return Boolean(config.whisperLocalBaseUrl);
  }

  async transcribe(audio: PreparedAudio, input: STTInput, config: ResolvedSttConfig): Promise<STTOutput> {
    const baseUrl = config.whisperLocalBaseUrl || DEFAULT_WHISPER_LOCAL_BASE_URL;
    const model = input.model || 'base';
    const response = await fetch(
      `${stripTrailingSlash(baseUrl)}/audio/transcriptions`,
      {
        method: 'POST',
        body: buildOpenAiFormData(audio, input, model),
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Whisper-local transcription failed (${response.status}): ${message}. ` +
          'Ensure your local STT server exposes an OpenAI-compatible /audio/transcriptions endpoint.',
      );
    }

    return parseOpenAiLikeResponse(response, input, 'whisper-local', model);
  }
}

class DeepgramBackend implements SttBackend {
  readonly provider = 'deepgram' as const;

  isConfigured(config: ResolvedSttConfig): boolean {
    return Boolean(config.deepgramApiKey);
  }

  async transcribe(audio: PreparedAudio, input: STTInput, config: ResolvedSttConfig): Promise<STTOutput> {
    const model = input.model || 'nova-2';
    const params = new URLSearchParams({
      model,
      smart_format: String(input.smartFormat ?? true),
      punctuate: 'true',
      utterances: String(input.utterances ?? true),
      diarize: String(input.diarize ?? false),
    });

    if (input.language) params.set('language', input.language);
    if (input.detectLanguage) params.set('detect_language', 'true');
    if (input.prompt) params.set('keywords', input.prompt);

    const response = await fetch(
      `${stripTrailingSlash(config.deepgramBaseUrl)}/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.deepgramApiKey!}`,
          'Content-Type': audio.mimeType,
        },
        body: audio.data,
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Deepgram transcription failed (${response.status}): ${message}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const results =
      typeof payload.results === 'object' && payload.results !== null
        ? (payload.results as Record<string, unknown>)
        : {};
    const channels = Array.isArray(results.channels) ? results.channels : [];
    const firstChannel =
      channels.length > 0 && typeof channels[0] === 'object' && channels[0] !== null
        ? (channels[0] as Record<string, unknown>)
        : undefined;
    const alternatives = Array.isArray(firstChannel?.alternatives) ? firstChannel!.alternatives : [];
    const firstAlt =
      alternatives.length > 0 && typeof alternatives[0] === 'object' && alternatives[0] !== null
        ? (alternatives[0] as Record<string, unknown>)
        : undefined;
    const transcript = typeof firstAlt?.transcript === 'string' ? firstAlt.transcript : '';

    const metadata =
      typeof payload.metadata === 'object' && payload.metadata !== null
        ? (payload.metadata as Record<string, unknown>)
        : {};
    const language =
      typeof firstAlt?.detected_language === 'string'
        ? firstAlt.detected_language
        : typeof firstChannel?.detected_language === 'string'
          ? firstChannel.detected_language
          : input.language;

    return {
      text: transcript,
      provider: 'deepgram',
      model,
      language,
      confidence: typeof firstAlt?.confidence === 'number' ? firstAlt.confidence : undefined,
      durationSeconds:
        typeof metadata.duration === 'number' ? metadata.duration : undefined,
      segments: normalizeDeepgramSegments(payload),
      providerResponse: payload,
    };
  }
}

const STT_BACKENDS: Record<Exclude<STTProvider, 'auto'>, SttBackend> = {
  openai: new OpenAiBackend(),
  deepgram: new DeepgramBackend(),
  'whisper-local': new WhisperLocalBackend(),
};

/** The most bytes of audio read from a URL: 25 MiB, OpenAI's limit for one transcription upload. */
const MAX_AUDIO_URL_BYTES = 25 * 1024 * 1024;

/** How long reading an audio URL may take, the lookups and redirects included. */
const AUDIO_URL_DEADLINE_MS = 30_000;

/**
 * The media types an audio URL is read with: audio, the video containers the
 * transcription APIs take, and bytes a server labels as no type in
 * particular (many serve audio so).
 */
const AUDIO_URL_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/webm',
  'application/octet-stream',
];

/**
 * The bytes and media type of the audio at `address`, read through AgentOS's
 * `guardedFetch`: every address the host resolves to must be public, each
 * redirect is checked the same way, only ports 80 and 443 are read, and the
 * body is held to 25 MiB and the read to 30 seconds. The model writes the
 * URL, so a plain fetch would let it point the server at itself or its
 * network (`http://169.254.169.254/` is where cloud metadata services answer)
 * and hand what that answers to a transcription provider.
 *
 * @throws When the installed AgentOS has no `guardedFetch` (before 0.13.35),
 *   and when the read is refused or fails. An address that is not public and
 *   one that does not resolve get the same message, so the tool's error does
 *   not tell which internal names exist.
 */
async function downloadAudio(address: string): Promise<{ data: Buffer; contentType: string }> {
  let memory: { guardedFetch?: unknown } | undefined;
  try {
    memory = await import('@framers/agentos/cognition/memory');
  } catch {
    memory = undefined;
  }
  if (typeof memory?.guardedFetch !== 'function') {
    throw new Error(
      'audioUrl needs @framers/agentos 0.13.35 or later, whose guarded fetch checks the address: pass audioBase64, or update AgentOS.',
    );
  }
  try {
    const answer = await memory.guardedFetch(address, {
      maxBytes: MAX_AUDIO_URL_BYTES,
      deadlineMs: AUDIO_URL_DEADLINE_MS,
      accept: AUDIO_URL_TYPES,
    });
    return { data: answer.body, contentType: answer.contentType };
  } catch (error) {
    const { reason, status } = (error ?? {}) as { reason?: string; status?: number };
    switch (reason) {
      case 'address':
      case 'network':
        throw new Error('audioUrl could not be read from a public network address.');
      case 'size':
        throw new Error(`The audio at audioUrl is larger than ${MAX_AUDIO_URL_BYTES} bytes.`);
      case 'type':
        throw new Error('audioUrl did not answer with audio.');
      case 'deadline':
        throw new Error(`audioUrl took longer than ${AUDIO_URL_DEADLINE_MS / 1000} seconds to read.`);
      case 'status':
        throw new Error(`Audio download failed (${status ?? 'no status'}).`);
      case 'redirects':
        throw new Error('audioUrl redirected more than three times.');
      case 'scheme':
        throw new Error('audioUrl must be an http or https address without a user name or password.');
      case 'port':
        throw new Error('audioUrl must be on port 80 or 443.');
      default:
        throw error;
    }
  }
}

export class SpeechToTextTool implements ITool<STTInput, STTOutput> {
  readonly id = 'stt-multi-provider-v1';
  readonly name = 'speech_to_text';
  readonly displayName = 'Speech to Text';
  readonly description =
    'Transcribe audio into text. Supports OpenAI Whisper, Deepgram, and Whisper-local/OpenAI-compatible local STT runtimes. ' +
    'Accepts either base64 audio or the http(s) URL of audio on a public host.';
  readonly category = 'media';
  readonly version = '2.0.0';
  readonly hasSideEffects = false;
  readonly requiredCapabilities = ['capability:stt'];

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      audioBase64: {
        type: 'string',
        description: 'Base64 audio payload. May be raw base64 or a data URL.',
      },
      audioUrl: {
        type: 'string',
        description:
          'The http(s) URL of audio on a public host, at most 25 MiB, read when no audioBase64 is given. Addresses on this machine or a private network are refused.',
      },
      mimeType: {
        type: 'string',
        description: 'Optional MIME type override, such as audio/wav or audio/mpeg.',
      },
      fileName: {
        type: 'string',
        description: 'Optional filename sent to transcription providers.',
      },
      format: {
        type: 'string',
        description: 'Optional audio format hint, such as wav, mp3, m4a, or webm.',
      },
      language: {
        type: 'string',
        description: 'Optional ISO language hint, for example en or es.',
      },
      prompt: {
        type: 'string',
        description: 'Optional context prompt to bias the transcript.',
      },
      temperature: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Temperature override for Whisper-style providers.',
      },
      responseFormat: {
        type: 'string',
        enum: ['json', 'text', 'srt', 'verbose_json', 'vtt'],
        description: 'Response format for OpenAI-compatible providers.',
      },
      provider: {
        type: 'string',
        enum: ['auto', 'openai', 'deepgram', 'whisper-local'],
        description: 'STT provider selection. Default: auto.',
      },
      model: {
        type: 'string',
        description: 'Provider model override. Examples: whisper-1, nova-2, base.',
      },
      diarize: {
        type: 'boolean',
        description: 'Enable speaker diarization when the provider supports it.',
      },
      utterances: {
        type: 'boolean',
        description: 'Request utterance segmentation when the provider supports it.',
      },
      smartFormat: {
        type: 'boolean',
        description: 'Enable provider-side smart formatting where supported.',
      },
      detectLanguage: {
        type: 'boolean',
        description: 'Enable provider-side language detection where supported.',
      },
      providerOptions: {
        type: 'object',
        description: 'Optional provider-specific passthrough options for future-compatible callers.',
        additionalProperties: true,
      },
    },
  };

  private readonly config: ResolvedSttConfig;

  constructor(config?: STTConfig) {
    this.config = {
      openaiApiKey: config?.openaiApiKey || process.env.OPENAI_API_KEY || undefined,
      openaiBaseUrl: stripTrailingSlash(
        config?.openaiBaseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
      ),
      deepgramApiKey: config?.deepgramApiKey || process.env.DEEPGRAM_API_KEY || undefined,
      deepgramBaseUrl: stripTrailingSlash(
        config?.deepgramBaseUrl || process.env.DEEPGRAM_BASE_URL || DEFAULT_DEEPGRAM_BASE_URL,
      ),
      whisperLocalBaseUrl: config?.whisperLocalBaseUrl || process.env.WHISPER_LOCAL_BASE_URL || undefined,
      defaultProvider:
        config?.defaultProvider || (process.env.STT_PROVIDER as STTProvider) || 'auto',
    };
  }

  private resolveProvider(requested?: STTProvider): Exclude<STTProvider, 'auto'> | null {
    const preferred = requested || this.config.defaultProvider || 'auto';

    if (preferred !== 'auto') {
      if (preferred === 'whisper-local') return 'whisper-local';
      return STT_BACKENDS[preferred].isConfigured(this.config) ? preferred : null;
    }

    if (STT_BACKENDS.openai.isConfigured(this.config)) return 'openai';
    if (STT_BACKENDS.deepgram.isConfigured(this.config)) return 'deepgram';
    if (STT_BACKENDS['whisper-local'].isConfigured(this.config)) return 'whisper-local';
    return null;
  }

  private async prepareAudio(input: STTInput): Promise<PreparedAudio> {
    if (typeof input.audioBase64 === 'string' && input.audioBase64.trim()) {
      const normalized = normalizeBase64Input(input.audioBase64);
      const mimeType = input.mimeType || normalized.mimeType || 'audio/wav';
      const format = input.format || extensionFromMimeType(mimeType);
      return {
        data: normalized.data,
        mimeType,
        format,
        fileName: input.fileName || `audio.${format}`,
      };
    }

    if (typeof input.audioUrl === 'string' && input.audioUrl.trim()) {
      const downloaded = await downloadAudio(input.audioUrl.trim());
      // A server that names no type in particular says nothing of the format.
      const served = downloaded.contentType === 'application/octet-stream' ? '' : downloaded.contentType;
      const mimeType = input.mimeType || served || 'audio/wav';
      const format = input.format || extensionFromMimeType(mimeType);
      return {
        data: downloaded.data,
        mimeType,
        format,
        fileName: input.fileName || `audio.${format}`,
      };
    }

    throw new Error('Provide either audioBase64 or audioUrl.');
  }

  async execute(
    args: STTInput,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<STTOutput>> {
    try {
      const provider = this.resolveProvider(args.provider);
      if (!provider) {
        return {
          success: false,
          error:
            'No STT provider available. Configure OPENAI_API_KEY, DEEPGRAM_API_KEY, or WHISPER_LOCAL_BASE_URL. ' +
            'You can also explicitly set provider to "whisper-local" to target a local OpenAI-compatible STT server.',
        };
      }

      const audio = await this.prepareAudio(args);
      const output = await STT_BACKENDS[provider].transcribe(audio, args, this.config);
      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
