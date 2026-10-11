// @ts-nocheck
/**
 * @fileoverview text_to_speech end to end, through the pack's factory, with
 * nothing in the pack mocked: a local HTTP server stands in for each vendor
 * at its base URL option, the tool sends its real requests there with the
 * real fetch, and the audio it saves is read back from disk.
 *
 * The request shapes asserted here are the vendors' references':
 * https://developers.deepgram.com/reference/text-to-speech/speak-request,
 * openai-node's `resources/audio/speech.d.ts`, and
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert. A run
 * against the vendors themselves needs live keys and bills per call, so it is
 * not in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createExtensionPack } from '../src/index.js';

const WINDOWS = process.platform === 'win32';

/** Bytes that start as each format's file does (MP3: an empty ID3v2 tag, then a layer III frame). */
const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(242, 3)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(244, 5)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(252, 9)]);

const SECRETS = { 'deepgram.apiKey': 'dg-secret-key', 'openai.apiKey': 'sk-openai-secret', 'elevenlabs.apiKey': 'el-secret-key' };

const ENV = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_BASE_URL', 'DEEPGRAM_BASE_URL', 'OLLAMA_BASE_URL', 'TTS_PROVIDER', 'AGENTOS_AUDIO_DIR'];
const savedEnv: Record<string, string | undefined> = {};

/** What the stand-in server does with a request. */
type Answer = { status?: number; body?: Buffer | string; stall?: boolean; cutAfter?: number };
let answer: (request: Recorded) => Answer;
type Recorded = { method: string; rawUrl: string; url: URL; headers: Record<string, string>; body: string };
let requests: Recorded[] = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const recorded = {
      method: req.method,
      rawUrl: req.url,
      url: new URL(req.url, 'http://server.test'),
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    const { status = 200, body = MP3, stall, cutAfter } = answer(recorded);
    res.setHeader('connection', 'close');
    if (stall) {
      // Headers and a few bytes, then nothing more.
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.write(MP3.subarray(0, 8));
      return;
    }
    if (cutAfter !== undefined) {
      // Promises the whole body and drops the connection part way.
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(body.length) });
      res.write(Buffer.from(body).subarray(0, cutAfter), () => req.socket.destroy());
      return;
    }
    res.writeHead(status, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
});

let BASE = '';
/** The audio directory of this test file. */
const AUDIO = mkdtempSync(join(tmpdir(), 'voice-tts-http-'));

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(AUDIO, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  answer = () => ({});
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

/** The pack's text_to_speech tool, made by the factory from these options and secrets. */
function tts(options: Record<string, unknown> = {}, secrets: Record<string, string> = SECRETS) {
  const pack = createExtensionPack({
    options: {
      audioDir: AUDIO,
      deepgramBaseUrl: `${BASE}/deepgram/v1`,
      // A trailing slash, which the tool strips.
      openaiBaseUrl: `${BASE}/openai/v1/`,
      elevenLabsBaseUrl: `${BASE}/elevenlabs/v1`,
      ...options,
    },
    getSecret: (id: string) => secrets[id],
  });
  return pack.descriptors.find((descriptor) => descriptor.id === 'text_to_speech').payload;
}

/** A call's context for a user, as AgentOS passes one. */
const as = (userId: string) => ({ gmiId: 'gmi', personaId: 'persona', userContext: { userId } });

/** The audio files saved anywhere under a directory. */
function saved(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => /agentos-audio-/.test(name));
}

describe('a request to each provider, and the audio it saves', () => {
  it('asks Deepgram first under auto, saves the answer for the caller, and returns its URL', async () => {
    const result = await tts().execute({ text: 'Hello there', speed: 1.2 }, as('user-1'));

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/deepgram/v1/speak');
    // The encoding is always named, and no callback is ever sent.
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ model: 'aura-2-thalia-en', encoding: 'mp3', speed: '1.2' });
    expect(request.headers.authorization).toBe('Token dg-secret-key');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({ text: 'Hello there' });

    expect(result.success).toBe(true);
    const file = fileURLToPath(result.output.audioUrl);
    expect(readFileSync(file)).toEqual(MP3);
    expect(basename(file)).toMatch(/^agentos-audio-[0-9a-f]{32}\.mp3$/);
    expect(basename(dirname(file))).toMatch(/^u-[0-9a-f]{32}$/);
    if (!WINDOWS) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(result.output).toEqual({
      audioUrl: result.output.audioUrl,
      bytes: MP3.length,
      contentType: 'audio/mpeg',
      format: 'mp3',
      provider: 'deepgram',
      model: 'aura-2-thalia-en',
      voice: 'aura-2-thalia-en',
      characters: 11,
      durationEstimateMs: 800,
    });
  });

  it('asks Deepgram for WAV as linear16 in a wav container, with a voice name as its Aura-2 model', async () => {
    answer = () => ({ body: WAV });
    const result = await tts().execute({ text: 'Hi', provider: 'deepgram', voice: 'Luna', format: 'wav' }, {});

    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({ model: 'aura-2-luna-en', encoding: 'linear16', container: 'wav' });
    expect(result.output).toMatchObject({ contentType: 'audio/wav', format: 'wav', model: 'aura-2-luna-en' });
    expect(basename(fileURLToPath(result.output.audioUrl))).toMatch(/\.wav$/);
  });

  it('asks OpenAI with a custom voice as its id, the speed and the instructions', async () => {
    answer = () => ({ body: WAV });
    const result = await tts().execute(
      { text: 'Hi', provider: 'openai', voice: 'voice_custom1', format: 'wav', speed: 1.5, instructions: 'calm' },
      {},
    );

    const [request] = requests;
    expect(request.url.pathname).toBe('/openai/v1/audio/speech');
    expect(request.headers.authorization).toBe('Bearer sk-openai-secret');
    expect(JSON.parse(request.body)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: { id: 'voice_custom1' },
      input: 'Hi',
      response_format: 'wav',
      speed: 1.5,
      instructions: 'calm',
    });
    expect(result.output).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'voice_custom1', contentType: 'audio/wav' });
    expect(result.output).not.toHaveProperty('notSent');
  });

  it("lets a voice name pick its provider under auto: OpenAI's coral, ElevenLabs' josh", async () => {
    await tts().execute({ text: 'Hi', voice: 'Coral' }, {});
    answer = () => ({ body: OGG });
    const eleven = await tts().execute({ text: 'Hi', voice: 'josh', format: 'opus', speed: 1.1, stability: 0.4 }, {});

    expect(requests[0].url.pathname).toBe('/openai/v1/audio/speech');
    expect(JSON.parse(requests[0].body)).toEqual({ model: 'gpt-4o-mini-tts', voice: 'coral', input: 'Hi', response_format: 'mp3' });

    expect(requests[1].url.pathname).toBe('/elevenlabs/v1/text-to-speech/TxGEqnHWrfWFTfGW9XjX');
    expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({ output_format: 'opus_48000_64' });
    expect(requests[1].headers['xi-api-key']).toBe('el-secret-key');
    expect(JSON.parse(requests[1].body)).toEqual({
      text: 'Hi',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.1 },
    });
    expect(eleven.output).toMatchObject({ provider: 'elevenlabs', voice: 'josh', contentType: 'audio/ogg', format: 'opus' });
  });

  it('sends an ElevenLabs voice id as one path segment', async () => {
    await tts().execute({ text: 'Hi', provider: 'elevenlabs', voice: 'ab/cd ef' }, {});
    expect(requests[0].rawUrl).toBe('/elevenlabs/v1/text-to-speech/ab%2Fcd%20ef?output_format=mp3_44100_128');
  });

  it('asks an OpenAI-compatible server at its API base, with its key and the names as given', async () => {
    const tool = tts({ compatibleBaseUrl: `${BASE}/compat/v1`, compatibleApiKey: 'local-key-123' });
    const result = await tool.execute({ text: 'Hi', provider: 'openai-compatible', voice: 'af_bella', model: 'kokoro', instructions: 'slow' }, {});

    expect(requests[0].url.pathname).toBe('/compat/v1/audio/speech');
    expect(requests[0].headers.authorization).toBe('Bearer local-key-123');
    expect(JSON.parse(requests[0].body)).toEqual({ model: 'kokoro', voice: 'af_bella', input: 'Hi', response_format: 'mp3', instructions: 'slow' });
    expect(result.output).toMatchObject({ provider: 'openai-compatible', model: 'kokoro', voice: 'af_bella' });
  });

  it('keeps the old Ollama option as a server root, under the old provider name, and out of auto', async () => {
    const tool = tts({ ollamaBaseUrl: `${BASE}/legacy/`, defaultProvider: 'ollama' }, {});
    const result = await tool.execute({ text: 'Hi' }, {});

    expect(requests[0].url.pathname).toBe('/legacy/v1/audio/speech');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toEqual({ model: 'tts-1', voice: 'alloy', input: 'Hi', response_format: 'mp3' });
    expect(result.output.provider).toBe('openai-compatible');

    // With no key and no provider named, the server alone is not chosen.
    const auto = await tts({ ollamaBaseUrl: `${BASE}/legacy/` }, {}).execute({ text: 'Hi' }, {});
    expect(auto.success).toBe(false);
    expect(requests).toHaveLength(1);
  });
});

describe('an answer that is refused, with nothing saved', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-tts-refused-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['an error page sent with status 200', { body: '<!doctype html><title>502</title>' }, {}, "deepgram's answer is not mp3 audio"],
    ['another format than was asked', { body: MP3 }, { format: 'wav' }, "deepgram's answer is not wav audio"],
    ['an empty answer', { body: Buffer.alloc(0) }, {}, 'deepgram answered with no audio'],
  ])('%s', async (_name, served, args, message) => {
    answer = () => served;
    const result = await tts({ audioDir: dir }).execute({ text: 'Hi', ...args }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(saved(dir)).toEqual([]);
  });

  it('an answer past maxAudioBytes', async () => {
    answer = () => ({ body: Buffer.concat([MP3, Buffer.alloc(2048, 1)]) });
    const result = await tts({ audioDir: dir, maxAudioBytes: 1024 }).execute({ text: 'Hi' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("deepgram's answer is larger than 1024 bytes (maxAudioBytes)");
    expect(saved(dir)).toEqual([]);
  });

  it('an answer that stalls past requestTimeoutMs', async () => {
    answer = () => ({ stall: true });
    const result = await tts({ audioDir: dir, requestTimeoutMs: 300 }).execute({ text: 'Hi' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('deepgram took longer than 300 ms (requestTimeoutMs)');
    expect(saved(dir)).toEqual([]);
  });

  it('an answer the connection cuts off', async () => {
    answer = () => ({ body: Buffer.concat([MP3, Buffer.alloc(4096, 1)]), cutAfter: 100 });
    const result = await tts({ audioDir: dir }).execute({ text: 'Hi' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('deepgram request failed');
    expect(saved(dir)).toEqual([]);
  });

  it("a provider's refusal, with a key it echoes taken out", async () => {
    answer = () => ({ status: 401, body: '{"err_msg":"Invalid credentials for Token dg-secret-key"}' });
    const result = await tts({ audioDir: dir }).execute({ text: 'Hi' }, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('deepgram refused the request (401): {"err_msg":"Invalid credentials for Token [redacted]"}');
    expect(saved(dir)).toEqual([]);
  });
});

describe("the host's saveAudio", () => {
  it('gets the bytes, the content type, the tool and the context, and nothing is made on disk', async () => {
    const blocked = join(AUDIO, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const calls: unknown[] = [];
    const saveAudio = async (audio: unknown) => {
      calls.push(audio);
      return 'https://cdn.host.example/audio/1.mp3';
    };
    const context = as('user-2');

    const result = await tts({ saveAudio, audioDir: blocked }).execute({ text: 'Hi' }, context);

    expect(result.output.audioUrl).toBe('https://cdn.host.example/audio/1.mp3');
    expect(calls).toEqual([{ bytes: MP3, contentType: 'audio/mpeg', tool: 'text_to_speech', context }]);
    expect(readFileSync(blocked, 'utf8')).toBe('x');
  });

  it.each([
    [
      'throws',
      () => {
        throw 'disk full while holding sk-openai-secret';
      },
      "The host's saveAudio failed: disk full while holding [redacted]",
    ],
    ['rejects with null', async () => Promise.reject(null), "The host's saveAudio failed: null"],
    ['returns a file: URL', async () => 'file:///tmp/a.mp3', "The host's saveAudio must return an http(s) URL of at most 2,048 characters."],
  ])('fails the call when it %s', async (_name, saveAudio, message) => {
    const result = await tts({ saveAudio }).execute({ text: 'Hi' }, {});
    expect(result).toEqual({ success: false, error: message });
  });
});

describe.skipIf(WINDOWS)('the audio directory', () => {
  it('is refused before any request when a directory above it can be written by others, and taken when that one is sticky', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'voice-tts-parent-'));
    const audioDir = join(parent, 'audio');
    try {
      for (const mode of ['777', '775']) {
        execFileSync('chmod', [mode, parent]);
        const refused = await tts({ audioDir }).execute({ text: 'Hi' }, {});

        expect(refused.success).toBe(false);
        expect(refused.error).toContain(`The audio could not be saved under ${audioDir}`);
        expect(refused.error).toContain('above it, can be written by others and is not sticky');
        expect(refused.error).toContain(`mode 0${mode}`);
      }
      // A provider bills for the speech it makes: none was asked for.
      expect(requests).toEqual([]);

      // Sticky, as /tmp is: only an entry's owner can rename it.
      execFileSync('chmod', ['1777', parent]);
      const taken = await tts({ audioDir }).execute({ text: 'Hi' }, {});
      expect(taken.success).toBe(true);
      expect(readFileSync(fileURLToPath(taken.output.audioUrl))).toEqual(MP3);
    } finally {
      execFileSync('chmod', ['700', parent]);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a caller's directory that is a link, before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-tts-link-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'voice-tts-elsewhere-'));
    try {
      mkdirSync(join(dir, 'audio'));
      symlinkSync(elsewhere, join(dir, 'audio', 'shared'));
      const result = await tts({ audioDir: join(dir, 'audio') }).execute({ text: 'Hi' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('is not a directory that this user owns and no one else can write');
      expect(requests).toEqual([]);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('takes the directory from AGENTOS_AUDIO_DIR when the option names none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-tts-env-'));
    try {
      process.env.AGENTOS_AUDIO_DIR = dir;
      const result = await tts({ audioDir: undefined }).execute({ text: 'Hi' }, {});
      expect(saved(dir)).toHaveLength(1);
      expect(result.success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the manifest', () => {
  it("lists the pack's serializable options and the provider names", () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const properties = manifest.configuration.properties;

    for (const name of [
      'deepgram.apiKey',
      'deepgram.baseUrl',
      'openai.apiKey',
      'openai.baseUrl',
      'elevenlabs.apiKey',
      'elevenlabs.baseUrl',
      'compatible.baseUrl',
      'compatible.apiKey',
      'ollama.baseUrl',
      'tts.audioDir',
      'tts.maxAudioBytes',
      'tts.requestTimeoutMs',
    ]) {
      expect(properties).toHaveProperty([name]);
    }
    expect(properties['tts.defaultProvider'].enum).toEqual(['auto', 'deepgram', 'openai', 'elevenlabs', 'openai-compatible', 'ollama']);
  });
});
