// @ts-nocheck
/**
 * Voice Synthesis Extension Pack: text_to_speech (Deepgram, OpenAI,
 * ElevenLabs, or an OpenAI-compatible speech server) and speech_to_text
 * (OpenAI, Deepgram, or a Whisper-compatible server). Each picks a provider
 * from the keys it has.
 */

import type { SaveAudio } from './audioFiles.js';
import { TextToSpeechTool, type TTSConfig, type TTSProvider } from './tools/textToSpeech.js';
import { SpeechToTextTool, type STTConfig, type STTProvider } from './tools/speechToText.js';
import { PACKAGE_VERSION, warnWhenVersionUnknown } from './packageVersion.js';

export interface VoiceSynthesisExtensionOptions {
  elevenLabsApiKey?: string;
  /** An API base, default https://api.elevenlabs.io/v1. */
  elevenLabsBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  deepgramApiKey?: string;
  deepgramBaseUrl?: string;
  /** The API base of an OpenAI-compatible speech server, such as http://localhost:8880/v1. */
  compatibleBaseUrl?: string;
  compatibleApiKey?: string;
  /** The old option for that server, a server root such as http://localhost:11434. */
  ollamaBaseUrl?: string;
  whisperLocalBaseUrl?: string;
  defaultProvider?: TTSProvider;
  defaultSttProvider?: STTProvider;
  /** Where the default saver writes audio (else AGENTOS_AUDIO_DIR, else a folder in the temp directory). */
  audioDir?: string;
  /** The host's saver: stores the audio and returns the http(s) URL its clients load. */
  saveAudio?: SaveAudio;
  /** The most bytes of audio read from one answer. Default 128 MiB. */
  maxAudioBytes?: number;
  /** The deadline of one speech request, in milliseconds. Default 300,000. */
  requestTimeoutMs?: number;
  priority?: number;
}

export function createExtensionPack(context: any) {
  const options = (context.options || {}) as VoiceSynthesisExtensionOptions;

  const config: TTSConfig = {
    deepgramApiKey: options.deepgramApiKey || context.getSecret?.('deepgram.apiKey') || process.env.DEEPGRAM_API_KEY,
    deepgramBaseUrl: options.deepgramBaseUrl || process.env.DEEPGRAM_BASE_URL,
    openaiApiKey: options.openaiApiKey || context.getSecret?.('openai.apiKey') || process.env.OPENAI_API_KEY,
    openaiBaseUrl: options.openaiBaseUrl || process.env.OPENAI_BASE_URL,
    elevenLabsApiKey: options.elevenLabsApiKey || context.getSecret?.('elevenlabs.apiKey') || process.env.ELEVENLABS_API_KEY,
    elevenLabsBaseUrl: options.elevenLabsBaseUrl,
    compatibleBaseUrl: options.compatibleBaseUrl,
    compatibleApiKey: options.compatibleApiKey || context.getSecret?.('compatible.apiKey'),
    ollamaBaseUrl: options.ollamaBaseUrl || process.env.OLLAMA_BASE_URL,
    defaultProvider: options.defaultProvider || process.env.TTS_PROVIDER || 'auto',
    audioDir: options.audioDir,
    saveAudio: options.saveAudio,
    maxAudioBytes: options.maxAudioBytes,
    requestTimeoutMs: options.requestTimeoutMs,
  };
  const sttConfig: STTConfig = {
    openaiApiKey: options.openaiApiKey || context.getSecret?.('openai.apiKey') || process.env.OPENAI_API_KEY,
    openaiBaseUrl: options.openaiBaseUrl || process.env.OPENAI_BASE_URL,
    deepgramApiKey: options.deepgramApiKey || context.getSecret?.('deepgram.apiKey') || process.env.DEEPGRAM_API_KEY,
    deepgramBaseUrl: options.deepgramBaseUrl || process.env.DEEPGRAM_BASE_URL,
    whisperLocalBaseUrl: options.whisperLocalBaseUrl || process.env.WHISPER_LOCAL_BASE_URL,
    defaultProvider: options.defaultSttProvider || (process.env.STT_PROVIDER as STTProvider) || 'auto',
    audioDir: options.audioDir,
  };

  const ttsTool = new TextToSpeechTool(config);
  const sttTool = new SpeechToTextTool(sttConfig);

  const providers: string[] = [];
  if (config.deepgramApiKey) providers.push('Deepgram');
  if (config.openaiApiKey) providers.push('OpenAI');
  if (config.elevenLabsApiKey) providers.push('ElevenLabs');
  if (config.compatibleBaseUrl || config.ollamaBaseUrl) providers.push('OpenAI-compatible server (when named)');
  const sttProviders: string[] = [];
  if (sttConfig.openaiApiKey) sttProviders.push('OpenAI Whisper');
  if (sttConfig.deepgramApiKey) sttProviders.push('Deepgram');
  if (sttConfig.whisperLocalBaseUrl) sttProviders.push('Whisper-local');

  const features: string[] = [
    `TTS: ${providers.length > 0 ? providers.join(', ') : 'not configured'}`,
    `STT: ${sttProviders.length > 0 ? sttProviders.join(', ') : 'not configured'}`,
  ];

  warnWhenVersionUnknown(context.logger);

  return {
    name: '@framers/agentos-ext-voice-synthesis',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: ttsTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: ttsTool,
        requiredSecrets: [],
      },
      {
        id: sttTool.name,
        kind: 'tool' as const,
        priority: options.priority || 50,
        payload: sttTool,
        requiredSecrets: [],
      },
    ],
    onActivate: async () => {
      context.logger?.info?.(`Voice Synthesis activated — ${features.join(' | ')}`);
    },
    onDeactivate: async () => {
      context.logger?.info?.('Voice Synthesis deactivated');
    },
  };
}

export { TextToSpeechTool };
export { SpeechToTextTool };
export type { TTSInput, TTSOutput, TTSConfig, TTSProvider, TTSFormat } from './tools/textToSpeech.js';
export type { SaveAudio } from './audioFiles.js';
export type { STTInput, STTOutput, STTConfig, STTProvider } from './tools/speechToText.js';
export default createExtensionPack;
