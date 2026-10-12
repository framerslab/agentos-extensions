// @ts-nocheck
/**
 * @fileoverview speech_to_text reading the audio text_to_speech saved, through
 * the pack's factory with nothing in the pack mocked: a local HTTP server
 * stands in for Deepgram's speak endpoint and OpenAI's transcription
 * endpoint, the tools send their real requests there, and the audio
 * text_to_speech saves is the audio speech_to_text uploads.
 *
 * A saved file is read only for the caller it was saved for, only from that
 * caller's directory, only as a regular file with one link and the saver's
 * name, and only while its bytes are still the format its name says.
 */
import { copyFileSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createExtensionPack } from '../src/index.js';

const WINDOWS = process.platform === 'win32';

/** An MP3 as far as its first bytes go: an empty ID3v2 tag, then a layer III frame. */
const MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(242, 3)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(244, 5)]);

type Recorded = { method: string; path: string; headers: Record<string, string>; body: Buffer };
let requests: Recorded[] = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const recorded = { method: req.method, path: new URL(req.url, 'http://server.test').pathname, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(recorded);
    res.setHeader('connection', 'close');
    if (recorded.path === '/deepgram/v1/speak') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(MP3);
      return;
    }
    if (recorded.path === '/openai/v1/audio/transcriptions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'hello there', language: 'en', duration: 1.2 }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no such route"}');
  });
});

let BASE = '';
/** The audio directory of this test file. */
const AUDIO = mkdtempSync(join(tmpdir(), 'voice-stt-saved-'));
/** A directory outside it. */
const OUTSIDE = mkdtempSync(join(tmpdir(), 'voice-stt-outside-'));

const ENV = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_BASE_URL', 'DEEPGRAM_BASE_URL', 'TTS_PROVIDER', 'STT_PROVIDER', 'AGENTOS_AUDIO_DIR'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const name of ENV) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(AUDIO, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  for (const name of ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

beforeEach(() => {
  requests = [];
});

/** The pack's two tools, made by the factory with the server as both vendors. */
function tools() {
  const pack = createExtensionPack({
    options: { audioDir: AUDIO, deepgramBaseUrl: `${BASE}/deepgram/v1`, openaiBaseUrl: `${BASE}/openai/v1` },
    getSecret: (id: string) => ({ 'deepgram.apiKey': 'dg-key', 'openai.apiKey': 'sk-openai' })[id],
  });
  const byId = Object.fromEntries(pack.descriptors.map((descriptor) => [descriptor.id, descriptor.payload]));
  return { tts: byId.text_to_speech, stt: byId.speech_to_text };
}

/** A call's context for a user, as AgentOS passes one. */
const as = (userId: string) => ({ gmiId: 'gmi', personaId: 'persona', userContext: { userId } });

/** Speaks for `userId` and returns the file: URL of the audio saved. */
async function spoken(userId: string): Promise<string> {
  const result = await tools().tts.execute({ text: 'Hello there', provider: 'deepgram' }, as(userId));
  expect(result.error).toBeUndefined();
  return result.output.audioUrl;
}

/** The transcription requests the server received. */
const transcriptions = () => requests.filter((request) => request.path === '/openai/v1/audio/transcriptions');

describe('speech_to_text with a file: URL', () => {
  it('uploads the audio text_to_speech saved for the same caller, with its type', async () => {
    const audioUrl = await spoken('alice');
    expect(audioUrl).toMatch(/^file:\/\/.*agentos-audio-[0-9a-f]{32}\.mp3$/);

    const result = await tools().stt.execute({ audioUrl, provider: 'openai' }, as('alice'));

    expect(result.error).toBeUndefined();
    expect(result.output.text).toBe('hello there');
    expect(transcriptions()).toHaveLength(1);
    const [request] = transcriptions();
    expect(request.headers.authorization).toBe('Bearer sk-openai');
    const form = await new Response(request.body, { headers: { 'content-type': request.headers['content-type'] } }).formData();
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/mpeg');
    expect(file.name).toBe('audio.mp3');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(MP3);
  });

  describe('refuses, and sends the provider nothing', () => {
    const REFUSAL = 'audioUrl is a file: URL that is not audio text_to_speech saved for this caller: other local files are not read.';

    async function refused(audioUrl: string, userId = 'alice') {
      const before = transcriptions().length;
      const result = await tools().stt.execute({ audioUrl, provider: 'openai' }, as(userId));
      expect(result).toEqual({ success: false, error: REFUSAL });
      expect(transcriptions()).toHaveLength(before);
    }

    it('audio saved for another caller', async () => {
      await refused(await spoken('alice'), 'bob');
    });

    it('a copy with the saver name in the audio directory, outside the caller directory', async () => {
      const saved = fileURLToPath(await spoken('alice'));
      const copy = join(AUDIO, `agentos-audio-${'a'.repeat(32)}.mp3`);
      copyFileSync(saved, copy);
      await refused(pathToFileURL(copy).href);
    });

    it('a file in the caller directory without the saver name', async () => {
      const dir = dirname(fileURLToPath(await spoken('alice')));
      const other = join(dir, 'notes.mp3');
      writeFileSync(other, MP3, { mode: 0o600 });
      await refused(pathToFileURL(other).href);
    });

    it('a saved name whose bytes are not the format it says', async () => {
      const dir = dirname(fileURLToPath(await spoken('alice')));
      const wrong = join(dir, `agentos-audio-${'b'.repeat(32)}.mp3`);
      writeFileSync(wrong, WAV, { mode: 0o600 });
      await refused(pathToFileURL(wrong).href);
    });

    it.skipIf(WINDOWS)('a link with the saver name to a file outside the audio directory', async () => {
      const dir = dirname(fileURLToPath(await spoken('alice')));
      const target = join(OUTSIDE, `agentos-audio-${'c'.repeat(32)}.mp3`);
      writeFileSync(target, MP3, { mode: 0o600 });
      const link = join(dir, `agentos-audio-${'d'.repeat(32)}.mp3`);
      symlinkSync(target, link);
      await refused(pathToFileURL(link).href);
    });

    it.skipIf(WINDOWS)('a saved file with a second hard link', async () => {
      const saved = fileURLToPath(await spoken('alice'));
      linkSync(saved, join(OUTSIDE, 'second-link.mp3'));
      await refused(pathToFileURL(saved).href);
    });

    it('a file: URL with a host, and a path that does not exist', async () => {
      await refused(`file://server.example/agentos-audio-${'e'.repeat(32)}.mp3`);
      await refused(pathToFileURL(join(AUDIO, 'missing', `agentos-audio-${'f'.repeat(32)}.mp3`)).href);
    });
  });
});
