// @ts-nocheck
/**
 * @fileoverview text_to_speech's rules, with fetch stubbed: the formats an
 * answer is taken as, and every refusal, each made before any request. The
 * requests themselves run against a local server in textToSpeech.http.spec.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { TextToSpeechTool, audioContainer } = await import('../src/tools/textToSpeech.js');
const { createExtensionPack } = await import('../src/index.js');

const ENV = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_BASE_URL', 'DEEPGRAM_BASE_URL', 'OLLAMA_BASE_URL', 'TTS_PROVIDER', 'AGENTOS_AUDIO_DIR'];
const savedEnv: Record<string, string | undefined> = {};

/** The audio directory of this test file. */
const AUDIO = mkdtempSync(join(tmpdir(), 'voice-tts-spec-'));
afterAll(() => rmSync(AUDIO, { recursive: true, force: true }));

/** Bytes that start as an MP3 file does. */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61, 7)]);

beforeEach(() => {
  mockFetch.mockReset();
  for (const name of ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

/** A tool with these keys and options, saving under this file's directory. */
const tool = (config = {}) => new TextToSpeechTool({ audioDir: AUDIO, ...config });

/** Runs a call that must be refused before any request, and returns its error. */
async function refused(config, args) {
  const result = await tool(config).execute(args, {});
  expect(result.success).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
  return result.error;
}

describe('audioContainer', () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]);
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
  const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(20)]);
  const adts = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80]), Buffer.alloc(20)]);
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(20)]);
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(20)]);
  const html = Buffer.from('<!doctype html><title>Bad gateway</title>');
  const json = Buffer.from('{"error":"quota"}');

  it.each([
    ['mp3 with an ID3 tag', 'mp3', MP3, 'audio/mpeg'],
    ['mp3 from its first frame', 'mp3', frame, 'audio/mpeg'],
    ['aac as ADTS', 'aac', adts, 'audio/aac'],
    ['aac in an MP4 file', 'aac', m4a, 'audio/mp4'],
    ['opus in Ogg', 'opus', ogg, 'audio/ogg'],
    ['opus in WebM', 'opus', webm, 'audio/webm'],
    ['flac', 'flac', flac, 'audio/flac'],
    ['wav', 'wav', wav, 'audio/wav'],
  ])('takes %s', (_name, format, bytes, contentType) => {
    expect(audioContainer(format, bytes)?.contentType).toBe(contentType);
  });

  it.each([
    ['an HTML page for mp3', 'mp3', html],
    ['JSON for mp3', 'mp3', json],
    ['mp3 for wav', 'wav', MP3],
    ['an mp3 frame for aac', 'aac', frame],
    ['flac for opus', 'opus', flac],
    ['Ogg for flac', 'flac', ogg],
    ['a bare RIFF header for wav', 'wav', Buffer.from('RIFF')],
  ])('refuses %s', (_name, format, bytes) => {
    expect(audioContainer(format, bytes)).toBeUndefined();
  });
});

describe('the provider of a call', () => {
  it('fails at once, naming the keys, when no provider is set up', async () => {
    const error = await refused({}, { text: 'Hello' });
    expect(error).toContain('DEEPGRAM_API_KEY, OPENAI_API_KEY or ELEVENLABS_API_KEY');
  });

  it('refuses a named provider without its key, and never runs another', async () => {
    const error = await refused({ openaiApiKey: 'sk-openai-key' }, { text: 'Hello', provider: 'elevenlabs' });
    expect(error).toBe('provider elevenlabs needs ELEVENLABS_API_KEY or the secret elevenlabs.apiKey.');
  });

  it('refuses the compatible provider, or its old name, without a base URL', async () => {
    for (const provider of ['openai-compatible', 'ollama']) {
      expect(await refused({}, { text: 'Hello', provider })).toContain('compatibleBaseUrl');
    }
  });

  it('refuses a voice of a provider that has no key, under auto', async () => {
    const error = await refused({ deepgramApiKey: 'dg-deepgram-key' }, { text: 'Hello', voice: 'nova' });
    expect(error).toBe('voice nova is a voice of openai, and provider openai needs OPENAI_API_KEY or the secret openai.apiKey.');
  });

  it('refuses a provider, or a default provider, it does not know', async () => {
    expect(await refused({ openaiApiKey: 'sk-openai-key' }, { text: 'Hello', provider: 'polly' })).toContain('provider must be one of');
    expect(await refused({ openaiApiKey: 'sk-openai-key', defaultProvider: 'polly' }, { text: 'Hello' })).toContain('provider must be one of');
    process.env.TTS_PROVIDER = 'nonsense';
    expect(await refused({ openaiApiKey: 'sk-openai-key' }, { text: 'Hello' })).toContain('provider must be one of');
  });
});

describe('the arguments', () => {
  const keys = { deepgramApiKey: 'dg-deepgram-key', openaiApiKey: 'sk-openai-key', elevenLabsApiKey: 'el-eleven-key' };

  it.each([{}, { text: 42 }, { text: '   ' }, { text: ['a'] }])('refuses text %o', async (args) => {
    expect(await refused(keys, args)).toBe('text must be a string with something to speak.');
  });

  it.each([
    ['deepgram', undefined, 2000],
    ['openai', undefined, 4096],
    ['elevenlabs', 'eleven_v3', 5000],
    ['elevenlabs', 'eleven_multilingual_v2', 10000],
  ])('refuses text over what %s %s takes (%i characters), and never cuts it', async (provider, model, limit) => {
    const error = await refused(keys, { text: 'a'.repeat(limit + 1), provider, model });
    expect(error).toContain(`takes at most ${limit}`);
    expect(error).toContain(`text is ${limit + 1} characters`);
  });

  it('counts characters, not UTF-16 units, against a limit', async () => {
    mockFetch.mockResolvedValueOnce(new Response(MP3));
    const result = await tool(keys).execute({ text: '😀'.repeat(2000), provider: 'deepgram' }, {});
    expect(result.success).toBe(true);
    expect(result.output.characters).toBe(2000);
  });

  it.each([
    [{ speed: Number.NaN }, 'speed must be a finite number.'],
    [{ speed: Number.POSITIVE_INFINITY }, 'speed must be a finite number.'],
    [{ speed: '1.2' }, 'speed must be a finite number.'],
    [{ stability: 2 }, 'stability must be between 0 and 1.'],
    [{ similarity_boost: -0.1 }, 'similarity_boost must be between 0 and 1.'],
    [{ voice: '' }, 'voice must be a non-empty string.'],
    [{ model: 7 }, 'model must be a non-empty string.'],
    [{ instructions: { tone: 'warm' } }, 'instructions must be a string.'],
    [{ format: 'pcm' }, 'format must be one of mp3, opus, aac, flac, wav.'],
  ])('refuses %o', async (extra, message) => {
    expect(await refused(keys, { text: 'Hello', ...extra })).toBe(message);
  });

  it.each([
    ['openai', 5, 'speed for openai must be between 0.25 and 4.'],
    ['deepgram', 2, 'speed for deepgram must be between 0.7 and 1.5.'],
  ])('refuses a speed outside what %s documents', async (provider, speed, message) => {
    expect(await refused(keys, { text: 'Hello', provider, speed })).toBe(message);
  });

  it('refuses ElevenLabs formats it does not make, and its Text to Dialogue models', async () => {
    expect(await refused(keys, { text: 'Hello', provider: 'elevenlabs', format: 'aac' })).toBe('ElevenLabs makes no aac: use mp3, opus or wav.');
    for (const model of ['eleven_v4', 'eleven_v4_turbo']) {
      expect(await refused(keys, { text: 'Hello', provider: 'elevenlabs', model })).toContain('Text to Dialogue API');
    }
  });

  it('does not send a setting the provider does not take, and says so', async () => {
    mockFetch.mockResolvedValueOnce(new Response(MP3));
    const result = await tool(keys).execute({ text: 'Hello', provider: 'openai', model: 'tts-1-hd', stability: 0.3, instructions: 'warm' }, {});

    expect(result.output.notSent).toEqual(['stability', 'instructions']);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('stability');
    expect(body).not.toHaveProperty('instructions');
  });

  it('turns no voice into another: an OpenAI voice it does not know goes as a custom voice', async () => {
    mockFetch.mockResolvedValueOnce(new Response(MP3));
    const result = await tool(keys).execute({ text: 'Hello', provider: 'openai', voice: 'novaa' }, {});
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).voice).toEqual({ id: 'novaa' });
    expect(result.output.voice).toBe('novaa');
  });
});

describe('the answer', () => {
  it('saves the audio and returns its URL, with no audio and no text in the output', async () => {
    mockFetch.mockResolvedValueOnce(new Response(MP3));
    const result = await tool({ deepgramApiKey: 'dg-deepgram-key' }).execute({ text: 'one two three' }, {});

    expect(result.success).toBe(true);
    expect(readFileSync(fileURLToPath(result.output.audioUrl))).toEqual(MP3);
    expect(result.output).toMatchObject({
      bytes: MP3.length,
      contentType: 'audio/mpeg',
      format: 'mp3',
      provider: 'deepgram',
      model: 'aura-2-thalia-en',
      characters: 13,
    });
    expect(result.output).not.toHaveProperty('audioBase64');
    expect(result.output).not.toHaveProperty('text');
    expect(JSON.stringify(result.output)).not.toContain(MP3.toString('base64'));
  });

  it('gives a provider error without any configured key in it', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad header Authorization: Token dg-deepgram-key', { status: 401 }));
    const result = await tool({ deepgramApiKey: 'dg-deepgram-key' }).execute({ text: 'Hello' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('deepgram refused the request (401)');
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('dg-deepgram-key');
  });

  it('gives a network failure as an error', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const result = await tool({ openaiApiKey: 'sk-openai-key' }).execute({ text: 'Hello' }, {});
    expect(result).toEqual({ success: false, error: 'openai request failed: fetch failed (ECONNREFUSED)' });
  });
});

describe('the limit options', () => {
  it.each([0, -1, 1.5, Number.NaN, '1024'])('refuses maxAudioBytes %o when the tool is made', (maxAudioBytes) => {
    expect(() => new TextToSpeechTool({ maxAudioBytes })).toThrow('voice-synthesis: maxAudioBytes must be a positive whole number');
  });

  it('refuses requestTimeoutMs of 0 when the pack is made', () => {
    expect(() => createExtensionPack({ options: { requestTimeoutMs: 0 } })).toThrow('voice-synthesis: requestTimeoutMs must be a positive whole number');
  });
});

describe('metadata', () => {
  it('names the tool, marks no side effects, and names the providers', () => {
    const tts = new TextToSpeechTool({});
    expect(tts.name).toBe('text_to_speech');
    expect(tts.hasSideEffects).toBe(false);
    expect(tts.inputSchema.required).toEqual(['text']);
    for (const provider of ['Deepgram', 'OpenAI', 'ElevenLabs']) expect(tts.description).toContain(provider);
  });

  it("gives the pack its package's version and both tools", () => {
    const pack = createExtensionPack({ options: {}, logger: { info: vi.fn() } });
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pack.name).toBe('@framers/agentos-ext-voice-synthesis');
    expect(pack.version).toBe(version);
    expect(pack.descriptors.map((descriptor) => descriptor.id)).toEqual(['text_to_speech', 'speech_to_text']);
  });
});
