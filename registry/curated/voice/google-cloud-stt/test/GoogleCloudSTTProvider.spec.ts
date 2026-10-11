// @ts-nocheck
/**
 * @file GoogleCloudSTTProvider.spec.ts
 * @description Unit tests for {@link GoogleCloudSTTProvider}.
 *
 * The `@google-cloud/speech` SDK is mocked via `vi.mock` so tests run without
 * a real GCP project or network connection.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google-cloud/speech
// ---------------------------------------------------------------------------

/** Captured constructor call arguments for assertions. */
const mockInstances: Array<{ options: unknown; recognizeCalls: unknown[] }> = [];

vi.mock('@google-cloud/speech', () => {
  class MockSpeechClient {
    _options: unknown;
    _recognizeCalls: unknown[] = [];

    constructor(options: unknown) {
      this._options = options;
      mockInstances.push({ options, recognizeCalls: this._recognizeCalls });
    }

    async recognize(request: unknown) {
      this._recognizeCalls.push(request);
      // Return a minimal Cloud Speech response.
      return [
        {
          results: [
            {
              alternatives: [
                { transcript: 'hello world', confidence: 0.97 },
              ],
            },
            {
              alternatives: [
                { transcript: 'goodbye world', confidence: 0.73 },
              ],
            },
          ],
        },
      ];
    }
  }

  return { SpeechClient: MockSpeechClient };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER mock declaration
// ---------------------------------------------------------------------------

import { GoogleCloudSTTProvider } from '../src/GoogleCloudSTTProvider.js';
import { createExtensionPack } from '../src/index.js';

/**
 * The shape of a real service-account key: https URLs, and `\n` escapes inside
 * private_key once it is JSON. Every value is made up.
 */
const SERVICE_ACCOUNT_KEY = {
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: '0123456789abcdef0123456789abcdef01234567',
  private_key: '-----BEGIN DEMO KEY-----\nZmFrZS1rZXktYm9keQ/demo+body==\n-----END DEMO KEY-----\n',
  client_email: 'stt@demo-project.iam.gserviceaccount.com',
  client_id: '100000000000000000000',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:
    'https://www.googleapis.com/robot/v1/metadata/x509/stt%40demo-project.iam.gserviceaccount.com',
};

/**
 * Key files for the path tests: the provider refuses a value that is neither
 * a key nor the path of an existing file. The relative paths are read with
 * this folder as the working directory.
 */
// By its real path, so the paths built here have no link in them (the temp
// folder itself sits behind one on macOS).
const KEYS = realpathSync.native(mkdtempSync(join(tmpdir(), 'google-stt-keys-')));
/** A file name with backslashes: one name on POSIX, and not a name Windows can create here. */
const BACKSLASH_NAME = 'C:\\keys\\service-account.json';
const WINDOWS = process.platform === 'win32';
for (const name of ['service-account.json', 'sa.json', '{keys}/service-account.json', ...(WINDOWS ? [] : [BACKSLASH_NAME])]) {
  mkdirSync(join(KEYS, name, '..'), { recursive: true });
  writeFileSync(join(KEYS, name), JSON.stringify(SERVICE_ACCOUNT_KEY));
}
afterAll(() => rmSync(KEYS, { recursive: true, force: true }));

/** The result of `run`, called with KEYS as the working directory. The provider keeps a relative path as the absolute one it had there. */
function inKeys<T>(run: () => T): T {
  const cwd = process.cwd();
  process.chdir(KEYS);
  try {
    return run();
  } finally {
    process.chdir(cwd);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePcmBuffer(seconds = 0.1, sampleRate = 16000): Buffer {
  // LINEAR16: 2 bytes per sample
  return Buffer.alloc(Math.round(seconds * sampleRate) * 2, 0);
}

/** A mono 16-bit PCM WAV file: the 44-byte RIFF header, then the samples. */
function makeWavBuffer(sampleRate = 44100, seconds = 0.05): Buffer {
  const pcm = makePcmBuffer(seconds, sampleRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleCloudSTTProvider', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  // 1. id
  it('exposes id = "google-cloud-stt"', () => {
    const provider = new GoogleCloudSTTProvider('');
    expect(provider.id).toBe('google-cloud-stt');
  });

  // 2. No credentials: Application Default Credentials
  it('uses Application Default Credentials when no credentials are given', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({});
  });

  // File-path credentials: keyFilename
  it('passes keyFilename when credentials contain a path separator', async () => {
    const file = join(KEYS, 'service-account.json');
    const provider = new GoogleCloudSTTProvider(file);
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({ keyFilename: file });
  });

  it.skipIf(WINDOWS)('refuses a path whose ".." after a link reaches another file than the client would open', () => {
    // KEYS/link points to KEYS/tenant/keys, so the file system reads
    // KEYS/link/../sa.json as KEYS/tenant/sa.json, while the client, which
    // resolves the text, would open KEYS/sa.json, another key.
    mkdirSync(join(KEYS, 'tenant', 'keys'), { recursive: true });
    writeFileSync(join(KEYS, 'tenant', 'sa.json'), JSON.stringify(SERVICE_ACCOUNT_KEY));
    symlinkSync(join(KEYS, 'tenant', 'keys'), join(KEYS, 'link'), 'dir');

    expect(() => new GoogleCloudSTTProvider(`${KEYS}/link/../sa.json`)).toThrow(
      'GOOGLE_CLOUD_STT_CREDENTIALS names a key file through a link followed by ".."',
    );
  });

  it.skipIf(WINDOWS)('passes a key file in a Kubernetes Secret volume by its own path, which still opens after the volume is updated', async () => {
    // A Secret volume as the kubelet writes it: key.json links to
    // ..data/key.json, and ..data to a timestamped directory, which an
    // update replaces and then removes.
    const volume = join(KEYS, 'secret-volume');
    mkdirSync(join(volume, '..2026_10_11_00_30_00.1'), { recursive: true });
    writeFileSync(join(volume, '..2026_10_11_00_30_00.1', 'key.json'), JSON.stringify(SERVICE_ACCOUNT_KEY));
    symlinkSync('..2026_10_11_00_30_00.1', join(volume, '..data'));
    symlinkSync('..data/key.json', join(volume, 'key.json'));

    const provider = new GoogleCloudSTTProvider(join(volume, 'key.json'));
    await provider.transcribe({ data: makePcmBuffer() });
    expect(mockInstances[0]!.options).toEqual({ keyFilename: join(volume, 'key.json') });

    // The update: a new directory, ..data swung to it, the old one removed.
    const rotated = { ...SERVICE_ACCOUNT_KEY, private_key_id: 'rotated', client_email: 'rotated@demo-project.iam.gserviceaccount.com' };
    mkdirSync(join(volume, '..2026_10_12_00_30_00.2'));
    writeFileSync(join(volume, '..2026_10_12_00_30_00.2', 'key.json'), JSON.stringify(rotated));
    symlinkSync('..2026_10_12_00_30_00.2', join(volume, '..data_tmp'));
    renameSync(join(volume, '..data_tmp'), join(volume, '..data'));
    rmSync(join(volume, '..2026_10_11_00_30_00.1'), { recursive: true });

    // The path the client holds opens the new key, read by the SDK's own
    // auth loader (no network: it reads the file and builds the signer).
    const { SpeechClient } = await vi.importActual<typeof import('@google-cloud/speech')>('@google-cloud/speech');
    const real = new SpeechClient(mockInstances[0]!.options);
    const signer = await real.auth.getClient();
    expect(signer.email).toBe(rotated.client_email);
    expect(JSON.parse(readFileSync(String(mockInstances[0]!.options.keyFilename), 'utf8'))).toEqual(rotated);
  }, 60_000);

  // 3. JSON string credentials — uses credentials object
  it('parses inline JSON credentials', async () => {
    const creds = { client_email: 'test@project.iam.gserviceaccount.com', private_key: 'key' };
    const provider = new GoogleCloudSTTProvider(JSON.stringify(creds));
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: creds });
  });

  // 4. Windows-style path separator
  it.skipIf(WINDOWS)('treats backslash-containing strings as file paths', async () => {
    const file = join(KEYS, BACKSLASH_NAME);
    const provider = new GoogleCloudSTTProvider(file);
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ keyFilename: file });
  });

  // A real key holds '/' and backslashes, which the old rule took as the mark of a file path.
  it('passes a real inline service-account key as credentials', async () => {
    const provider = new GoogleCloudSTTProvider(`\n${JSON.stringify(SERVICE_ACCOUNT_KEY, null, 2)}\n`);
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('passes a key file path that starts with a brace as keyFilename', async () => {
    const provider = inKeys(() => new GoogleCloudSTTProvider('{keys}/service-account.json'));
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ keyFilename: inKeys(() => resolve('{keys}/service-account.json')) });
  });

  it('passes a key file path without a separator as keyFilename', async () => {
    const provider = inKeys(() => new GoogleCloudSTTProvider('service-account.json\n'));
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ keyFilename: inKeys(() => resolve('service-account.json')) });
  });

  it('refuses an inline key that is not valid JSON, and quotes none of it', () => {
    // A key cut short inside private_key, as a .env parser that stops at a line end leaves it.
    const json = JSON.stringify(SERVICE_ACCOUNT_KEY);
    const truncated = json.slice(0, json.indexOf('demo+body') + 'demo+body'.length);

    expect(() => new GoogleCloudSTTProvider(truncated)).toThrow('GOOGLE_CLOUD_STT_CREDENTIALS starts with "{" but is not valid JSON');
    let message = '';
    try {
      new GoogleCloudSTTProvider(truncated);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toContain('demo+body');
    expect(message).not.toContain('demo-project');
  });

  it('refuses a value that is neither a key nor an existing file, and quotes none of it', () => {
    // The key with its quotes escaped, as a .env file can leave it, and a missing path.
    const escaped = JSON.stringify(JSON.stringify(SERVICE_ACCOUNT_KEY)).slice(1, -1);
    for (const value of [escaped, join(KEYS, 'missing.json')]) {
      let message = '';
      try {
        new GoogleCloudSTTProvider(value);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toContain('GOOGLE_CLOUD_STT_CREDENTIALS is neither a service-account key as a JSON object nor the path of an existing file');
      expect(message).not.toContain('demo+body');
      expect(message).not.toContain('demo-project');
      expect(message).not.toContain('missing.json');
    }
  });

  it.each([
    ['on one line', JSON.stringify(SERVICE_ACCOUNT_KEY)],
    ['pretty-printed', JSON.stringify(SERVICE_ACCOUNT_KEY, null, 2)],
    ['pretty-printed with CRLF', JSON.stringify(SERVICE_ACCOUNT_KEY, null, 2).replace(/\n/g, '\r\n')],
  ])('reads a key %s whose \\n escapes were turned into line breaks', async (_form, json) => {
    // A double-quoted .env value: dotenv expands each \\n in private_key to a real line break.
    const expanded = json.replace(/\\n/g, '\n');
    const provider = new GoogleCloudSTTProvider(expanded);
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  // 5. recognize() request shape
  it('calls recognize() with correct encoding, sampleRate and languageCode', async () => {
    const provider = new GoogleCloudSTTProvider('');
    const pcm = makePcmBuffer(0.05, 16000);
    await provider.transcribe({ data: pcm, sampleRate: 16000 }, { language: 'fr-FR' });

    const calls = mockInstances[0]!.recognizeCalls as Array<{
      audio: { content: string };
      config: { encoding: string; sampleRateHertz: number; languageCode: string };
    }>;
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.audio.content).toBe(pcm.toString('base64'));
    expect(req.config.encoding).toBe('LINEAR16');
    expect(req.config.sampleRateHertz).toBe(16000);
    expect(req.config.languageCode).toBe('fr-FR');
  });

  // 6. Default language is en-US
  it('defaults languageCode to en-US when no options are passed', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makePcmBuffer() });

    const calls = mockInstances[0]!.recognizeCalls as Array<{
      config: { languageCode: string };
    }>;
    expect(calls[0]!.config.languageCode).toBe('en-US');
  });

  // 7. Default sampleRate is 16000
  it('defaults sampleRateHertz to 16000 when audio.sampleRate is omitted', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makePcmBuffer() });

    const calls = mockInstances[0]!.recognizeCalls as Array<{
      config: { sampleRateHertz: number };
    }>;
    expect(calls[0]!.config.sampleRateHertz).toBe(16000);
  });

  // 8. Response mapping
  it('returns the AgentOS transcription shape: every stretch\'s top alternative, in order', async () => {
    const provider = new GoogleCloudSTTProvider('');
    const result = await provider.transcribe({ data: makePcmBuffer() });

    expect(result.text).toBe('hello world goodbye world');
    expect(result.cost).toBe(0);
    expect(result.isFinal).toBe(true);
    expect(result.confidence).toBeCloseTo((0.97 + 0.73) / 2);
    expect(result.language).toBe('en-US');
    // The mock reports no end times, so no segment timing is invented.
    expect(result.segments).toBeUndefined();
  });

  // 9. Segment timing from Google's end times
  it('reports each stretch with its timing when Google gives end times', async () => {
    const provider = new GoogleCloudSTTProvider('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._client = {
      recognize: async () => [
        {
          results: [
            { alternatives: [{ transcript: 'first part', confidence: 0.9 }], resultEndTime: { seconds: '1', nanos: 500000000 } },
            { alternatives: [{ transcript: ' second part', confidence: 0.8 }], resultEndTime: { seconds: 3, nanos: 0 } },
          ],
        },
      ],
    };

    const result = await provider.transcribe({ data: makePcmBuffer() });

    expect(result.text).toBe('first part second part');
    expect(result.segments).toEqual([
      { text: 'first part', startTime: 0, endTime: 1.5, confidence: 0.9 },
      { text: 'second part', startTime: 1.5, endTime: 3, confidence: 0.8 },
    ]);
  });

  // 10. Empty results
  it('returns empty text when the API returns no results', async () => {
    const provider = new GoogleCloudSTTProvider('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._client = {
      recognize: async () => [{ results: [] }],
    };

    const result = await provider.transcribe({ data: makePcmBuffer() });
    expect(result.text).toBe('');
    expect(result.segments).toBeUndefined();
    expect(result.confidence).toBeUndefined();
  });

  // 11. Provider identity required by the AgentOS speech contract
  it('names itself and says it does not stream', () => {
    const provider = new GoogleCloudSTTProvider('');
    expect(provider.getProviderName()).toBe('Google Cloud Speech-to-Text');
    expect(provider.displayName).toBe('Google Cloud Speech-to-Text');
    expect(provider.supportsStreaming).toBe(false);
  });

  // 12. A WAV or FLAC header states its own encoding and sample rate
  it('leaves the encoding and sample rate to a WAV header', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makeWavBuffer(44100), mimeType: 'audio/wav' });

    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ languageCode: 'en-US' });
  });

  it('sends a stated sample rate for a WAV file, still without an encoding', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makeWavBuffer(44100), sampleRate: 44100 });

    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ sampleRateHertz: 44100, languageCode: 'en-US' });
  });

  it('leaves the encoding to a FLAC header', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(64)]) });

    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ languageCode: 'en-US' });
  });

  it('sends headerless PCM as LINEAR16 even when it is labelled audio/wav', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makePcmBuffer(), mimeType: 'audio/wav' });

    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US' });
  });
});

// ---------------------------------------------------------------------------
// Through AgentOS: the speech adapter and the fallback proxy
// ---------------------------------------------------------------------------

describe('GoogleCloudSTTProvider under AgentOS', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  it('gives the AgentOS speech adapter the transcript of a WAV file', async () => {
    const { SpeechProviderAdapter } = await import('@framers/agentos/cognition/rag/multimodal/SpeechProviderAdapter');
    const adapter = new SpeechProviderAdapter(new GoogleCloudSTTProvider(''));

    // The adapter labels the buffer audio/wav and reads result.text.
    const text = await adapter.transcribe(makeWavBuffer(44100), 'fr-FR');

    expect(text).toBe('hello world goodbye world');
    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ languageCode: 'fr-FR' });
  });

  it('gives the AgentOS speech adapter the transcript of raw PCM it labels audio/wav', async () => {
    const { SpeechProviderAdapter } = await import('@framers/agentos/cognition/rag/multimodal/SpeechProviderAdapter');
    const adapter = new SpeechProviderAdapter(new GoogleCloudSTTProvider(''));

    const text = await adapter.transcribe(makePcmBuffer(), 'fr-FR');

    expect(text).toBe('hello world goodbye world');
    const config = (mockInstances[0]!.recognizeCalls[0] as { config: Record<string, unknown> }).config;
    expect(config).toEqual({ encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'fr-FR' });
  });

  it('works first in an AgentOS fallback chain', async () => {
    const { FallbackSTTProxy } = await import('@framers/agentos/io/speech');
    const { EventEmitter } = await import('node:events');
    const proxy = new FallbackSTTProxy([new GoogleCloudSTTProvider('')], new EventEmitter());

    expect(proxy.getProviderName()).toBe('Google Cloud Speech-to-Text');
    const result = await proxy.transcribe({ data: makePcmBuffer() });
    expect(result.text).toBe('hello world goodbye world');
  });
});

// ---------------------------------------------------------------------------
// Through the pack factory, as the AgentOS extension manager loads it
// ---------------------------------------------------------------------------

describe('GoogleCloudSTTProvider through createExtensionPack', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  it('reads GOOGLE_CLOUD_STT_CREDENTIALS from the environment when no secret gives it', async () => {
    // AgentOS's extension manager reads the environment only for the ids in
    // its own catalog, which has neither speech pack's.
    const file = join(KEYS, 'sa.json');
    vi.stubEnv('GOOGLE_CLOUD_STT_CREDENTIALS', file);
    try {
      const pack = createExtensionPack({ getSecret: () => undefined });
      const provider = pack.descriptors[0]!.payload as GoogleCloudSTTProvider;
      await provider.transcribe({ data: makePcmBuffer() });

      expect(mockInstances[0]!.options).toEqual({ keyFilename: file });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('takes the secret over the environment variable', async () => {
    vi.stubEnv('GOOGLE_CLOUD_STT_CREDENTIALS', join(KEYS, 'missing.json'));
    try {
      const pack = createExtensionPack({
        getSecret: (id: string) => (id === 'GOOGLE_CLOUD_STT_CREDENTIALS' ? JSON.stringify(SERVICE_ACCOUNT_KEY) : undefined),
      });
      const provider = pack.descriptors[0]!.payload as GoogleCloudSTTProvider;
      await provider.transcribe({ data: makePcmBuffer() });

      expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads an inline key from GOOGLE_CLOUD_STT_CREDENTIALS', async () => {
    const pack = createExtensionPack({
      getSecret: (id: string) => (id === 'GOOGLE_CLOUD_STT_CREDENTIALS' ? JSON.stringify(SERVICE_ACCOUNT_KEY) : undefined),
    });
    const provider = pack.descriptors[0]!.payload as GoogleCloudSTTProvider;
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('reads a key from the secret after a .env file turned its \\n escapes into line breaks', async () => {
    const expanded = JSON.stringify(SERVICE_ACCOUNT_KEY).replace(/\\n/g, '\n');
    const pack = createExtensionPack({
      getSecret: (id: string) => (id === 'GOOGLE_CLOUD_STT_CREDENTIALS' ? expanded : undefined),
    });
    const provider = pack.descriptors[0]!.payload as GoogleCloudSTTProvider;
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('refuses to load with a secret that is neither a key nor a file, and quotes none of it', () => {
    const escaped = JSON.stringify(JSON.stringify(SERVICE_ACCOUNT_KEY)).slice(1, -1);
    let message = '';
    try {
      createExtensionPack({ getSecret: (id: string) => (id === 'GOOGLE_CLOUD_STT_CREDENTIALS' ? escaped : undefined) });
    } catch (error) {
      message = String((error as Error).message);
    }

    expect(message).toContain('GOOGLE_CLOUD_STT_CREDENTIALS is neither a service-account key as a JSON object nor the path of an existing file');
    expect(message).not.toContain('demo+body');
    expect(message).not.toContain('demo-project');
  });
});
