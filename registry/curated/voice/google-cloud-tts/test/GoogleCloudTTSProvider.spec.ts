// @ts-nocheck
/**
 * @file GoogleCloudTTSProvider.spec.ts
 * @description Unit tests for {@link GoogleCloudTTSProvider}.
 *
 * The `@google-cloud/text-to-speech` SDK is mocked via `vi.mock` so tests run
 * without a real GCP project or network connection.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google-cloud/text-to-speech
// ---------------------------------------------------------------------------

/** Track constructed client instances for assertion. */
const mockInstances: Array<{
  options: unknown;
  synthesizeCalls: unknown[];
  listVoicesCalls: number;
}> = [];

/** Fake MP3 bytes returned by the mock. */
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

vi.mock('@google-cloud/text-to-speech', () => {
  class MockTextToSpeechClient {
    _options: unknown;
    _synthesizeCalls: unknown[] = [];
    _listVoicesCalls = 0;

    constructor(options: unknown) {
      this._options = options;
      mockInstances.push({
        options,
        synthesizeCalls: this._synthesizeCalls,
        get listVoicesCalls() { return 0; }, // updated via the actual field
      });
    }

    async synthesizeSpeech(request: unknown) {
      this._synthesizeCalls.push(request);
      return [{ audioContent: new Uint8Array(FAKE_AUDIO) }];
    }

    async listVoices(_request: unknown) {
      this._listVoicesCalls++;
      return [
        {
          voices: [
            { name: 'en-US-Neural2-A', languageCodes: ['en-US'], ssmlGender: 'FEMALE' },
            { name: 'en-US-Neural2-B', languageCodes: ['en-US'], ssmlGender: 'MALE' },
            { name: 'fr-FR-Neural2-A', languageCodes: ['fr-FR'], ssmlGender: 'FEMALE' },
          ],
        },
      ];
    }
  }

  return { TextToSpeechClient: MockTextToSpeechClient };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER mock
// ---------------------------------------------------------------------------

import { GoogleCloudTTSProvider } from '../src/GoogleCloudTTSProvider.js';
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
  client_email: 'tts@demo-project.iam.gserviceaccount.com',
  client_id: '100000000000000000000',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:
    'https://www.googleapis.com/robot/v1/metadata/x509/tts%40demo-project.iam.gserviceaccount.com',
};

/**
 * Key files for the path tests: the provider refuses a value that is neither
 * a key nor the path of an existing file. The relative paths are read with
 * this folder as the working directory.
 */
// By its real path, so the paths built here have no link in them (the temp
// folder itself sits behind one on macOS).
const KEYS = realpathSync.native(mkdtempSync(join(tmpdir(), 'google-tts-keys-')));
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
// Tests
// ---------------------------------------------------------------------------

describe('GoogleCloudTTSProvider', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  // 1. id
  it('exposes id = "google-cloud-tts"', () => {
    const provider = new GoogleCloudTTSProvider('');
    expect(provider.id).toBe('google-cloud-tts');
  });

  // 2. No credentials: Application Default Credentials
  it('uses Application Default Credentials when no credentials are given', async () => {
    const provider = new GoogleCloudTTSProvider('');
    await provider.synthesize('hi');

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({});
  });

  // File-path credentials: keyFilename
  it('passes keyFilename when credentials contain a forward slash', async () => {
    const file = join(KEYS, 'sa.json');
    const provider = new GoogleCloudTTSProvider(file);
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ keyFilename: file });
  });

  it.skipIf(WINDOWS)('refuses a path whose ".." after a link reaches another file than the client would open', () => {
    // KEYS/link points to KEYS/tenant/keys, so the file system reads
    // KEYS/link/../sa.json as KEYS/tenant/sa.json, while the client, which
    // resolves the text, would open KEYS/sa.json, another key.
    mkdirSync(join(KEYS, 'tenant', 'keys'), { recursive: true });
    writeFileSync(join(KEYS, 'tenant', 'sa.json'), JSON.stringify(SERVICE_ACCOUNT_KEY));
    symlinkSync(join(KEYS, 'tenant', 'keys'), join(KEYS, 'link'), 'dir');

    expect(() => new GoogleCloudTTSProvider(`${KEYS}/link/../sa.json`)).toThrow(
      'GOOGLE_CLOUD_TTS_CREDENTIALS names a key file through a link followed by ".."',
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

    const provider = new GoogleCloudTTSProvider(join(volume, 'key.json'));
    await provider.synthesize('hi');
    expect(mockInstances[0]!.options).toEqual({ keyFilename: join(volume, 'key.json') });

    // The update: a new directory, ..data swung to it, the old one removed.
    const rotated = { ...SERVICE_ACCOUNT_KEY, private_key_id: 'rotated' };
    mkdirSync(join(volume, '..2026_10_12_00_30_00.2'));
    writeFileSync(join(volume, '..2026_10_12_00_30_00.2', 'key.json'), JSON.stringify(rotated));
    symlinkSync('..2026_10_12_00_30_00.2', join(volume, '..data_tmp'));
    renameSync(join(volume, '..data_tmp'), join(volume, '..data'));
    rmSync(join(volume, '..2026_10_11_00_30_00.1'), { recursive: true });

    // The path the client holds opens the new key.
    expect(JSON.parse(readFileSync(String(mockInstances[0]!.options.keyFilename), 'utf8'))).toEqual(rotated);
  });

  // 3. JSON string credentials
  it('parses inline JSON credentials', async () => {
    const creds = { client_email: 'tts@project.iam.gserviceaccount.com', private_key: 'key' };
    const provider = new GoogleCloudTTSProvider(JSON.stringify(creds));
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: creds });
  });

  // A real key holds '/' and backslashes, which the old rule took as the mark of a file path.
  it('passes a real inline service-account key as credentials', async () => {
    const provider = new GoogleCloudTTSProvider(`\n${JSON.stringify(SERVICE_ACCOUNT_KEY, null, 2)}\n`);
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('passes a key file path that starts with a brace as keyFilename', async () => {
    const provider = inKeys(() => new GoogleCloudTTSProvider('{keys}/service-account.json'));
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ keyFilename: inKeys(() => resolve('{keys}/service-account.json')) });
  });

  it('passes a key file path without a separator as keyFilename', async () => {
    const provider = inKeys(() => new GoogleCloudTTSProvider('service-account.json\n'));
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ keyFilename: inKeys(() => resolve('service-account.json')) });
  });

  it('refuses an inline key that is not valid JSON, and quotes none of it', () => {
    // A key cut short inside private_key, as a .env parser that stops at a line end leaves it.
    const json = JSON.stringify(SERVICE_ACCOUNT_KEY);
    const truncated = json.slice(0, json.indexOf('demo+body') + 'demo+body'.length);

    expect(() => new GoogleCloudTTSProvider(truncated)).toThrow('GOOGLE_CLOUD_TTS_CREDENTIALS starts with "{" but is not valid JSON');
    let message = '';
    try {
      new GoogleCloudTTSProvider(truncated);
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
        new GoogleCloudTTSProvider(value);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toContain('GOOGLE_CLOUD_TTS_CREDENTIALS is neither a service-account key as a JSON object nor the path of an existing file');
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
    const provider = new GoogleCloudTTSProvider(expanded);
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  // 4. synthesizeSpeech request shape — defaults
  it('calls synthesizeSpeech with MP3 encoding and default language', async () => {
    const provider = new GoogleCloudTTSProvider('');
    await provider.synthesize('Hello, world!');

    const calls = mockInstances[0]!.synthesizeCalls as Array<{
      input: { text: string };
      voice: { languageCode: string; name: unknown };
      audioConfig: { audioEncoding: string };
    }>;

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.input.text).toBe('Hello, world!');
    expect(req.voice.languageCode).toBe('en-US');
    expect(req.audioConfig.audioEncoding).toBe('MP3');
  });

  // 5. synthesizeSpeech with custom options
  it('forwards languageCode and voice name to synthesizeSpeech', async () => {
    const provider = new GoogleCloudTTSProvider('');
    await provider.synthesize('Bonjour', { languageCode: 'fr-FR', voice: 'fr-FR-Neural2-A' });

    const calls = mockInstances[0]!.synthesizeCalls as Array<{
      voice: { languageCode: string; name: string };
    }>;
    expect(calls[0]!.voice.languageCode).toBe('fr-FR');
    expect(calls[0]!.voice.name).toBe('fr-FR-Neural2-A');
  });

  // 6. SynthesisResult shape
  it('returns audioBuffer, mimeType and cost', async () => {
    const provider = new GoogleCloudTTSProvider('');
    const result = await provider.synthesize('test');

    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.cost).toBe(0);
    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(result.audioBuffer).toEqual(FAKE_AUDIO);
  });

  // 7. audioBuffer is a real Buffer
  it('wraps the Uint8Array audioContent in a Buffer', async () => {
    const provider = new GoogleCloudTTSProvider('');
    const result = await provider.synthesize('test');

    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
  });

  // 8. listAvailableVoices — count
  it('returns all voices from listVoices response', async () => {
    const provider = new GoogleCloudTTSProvider('');
    const voices = await provider.listAvailableVoices();

    expect(voices).toHaveLength(3);
  });

  // 9. listAvailableVoices — voice shape
  it('maps voice fields to SpeechVoice', async () => {
    const provider = new GoogleCloudTTSProvider('');
    const voices = await provider.listAvailableVoices();

    expect(voices[0]).toEqual({
      id: 'en-US-Neural2-A',
      name: 'en-US-Neural2-A',
      lang: 'en-US',
      languageCode: 'en-US',
      provider: 'google-cloud-tts',
      gender: 'female',
    });
  });

  // 10. listAvailableVoices — all language codes present
  it('includes voices for multiple language codes', async () => {
    const provider = new GoogleCloudTTSProvider('');
    const voices = await provider.listAvailableVoices();

    const codes = voices.map((v) => v.languageCode);
    expect(codes).toContain('fr-FR');
    expect(codes).toContain('en-US');
  });

  // 11. Provider identity required by the AgentOS speech contract
  it('names itself and says it does not stream', () => {
    const provider = new GoogleCloudTTSProvider('');
    expect(provider.getProviderName()).toBe('Google Cloud Text-to-Speech');
    expect(provider.displayName).toBe('Google Cloud Text-to-Speech');
    expect(provider.supportsStreaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through AgentOS: the fallback proxy
// ---------------------------------------------------------------------------

describe('GoogleCloudTTSProvider under AgentOS', () => {
  it('works first in an AgentOS fallback chain', async () => {
    const { FallbackTTSProxy } = await import('@framers/agentos/io/speech');
    const { EventEmitter } = await import('node:events');
    const proxy = new FallbackTTSProxy([new GoogleCloudTTSProvider('')], new EventEmitter());

    expect(proxy.getProviderName()).toBe('Google Cloud Text-to-Speech');
    const result = await proxy.synthesize('hello');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(Buffer.from(result.audioBuffer)).toEqual(FAKE_AUDIO);
  });
});

// ---------------------------------------------------------------------------
// Through the pack factory, as the AgentOS extension manager loads it
// ---------------------------------------------------------------------------

describe('GoogleCloudTTSProvider through createExtensionPack', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  it('reads GOOGLE_CLOUD_TTS_CREDENTIALS from the environment when no secret gives it', async () => {
    // AgentOS's extension manager reads the environment only for the ids in
    // its own catalog, which has neither speech pack's.
    const file = join(KEYS, 'sa.json');
    vi.stubEnv('GOOGLE_CLOUD_TTS_CREDENTIALS', file);
    try {
      const pack = createExtensionPack({ getSecret: () => undefined });
      const provider = pack.descriptors[0]!.payload as GoogleCloudTTSProvider;
      await provider.synthesize('hi');

      expect(mockInstances[0]!.options).toEqual({ keyFilename: file });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('takes the secret over the environment variable', async () => {
    vi.stubEnv('GOOGLE_CLOUD_TTS_CREDENTIALS', join(KEYS, 'missing.json'));
    try {
      const pack = createExtensionPack({
        getSecret: (id: string) => (id === 'GOOGLE_CLOUD_TTS_CREDENTIALS' ? JSON.stringify(SERVICE_ACCOUNT_KEY) : undefined),
      });
      const provider = pack.descriptors[0]!.payload as GoogleCloudTTSProvider;
      await provider.synthesize('hi');

      expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads an inline key from GOOGLE_CLOUD_TTS_CREDENTIALS', async () => {
    const pack = createExtensionPack({
      getSecret: (id: string) => (id === 'GOOGLE_CLOUD_TTS_CREDENTIALS' ? JSON.stringify(SERVICE_ACCOUNT_KEY) : undefined),
    });
    const provider = pack.descriptors[0]!.payload as GoogleCloudTTSProvider;
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('reads a key from the secret after a .env file turned its \\n escapes into line breaks', async () => {
    const expanded = JSON.stringify(SERVICE_ACCOUNT_KEY).replace(/\\n/g, '\n');
    const pack = createExtensionPack({
      getSecret: (id: string) => (id === 'GOOGLE_CLOUD_TTS_CREDENTIALS' ? expanded : undefined),
    });
    const provider = pack.descriptors[0]!.payload as GoogleCloudTTSProvider;
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: SERVICE_ACCOUNT_KEY });
  });

  it('refuses to load with a secret that is neither a key nor a file, and quotes none of it', () => {
    const escaped = JSON.stringify(JSON.stringify(SERVICE_ACCOUNT_KEY)).slice(1, -1);
    let message = '';
    try {
      createExtensionPack({ getSecret: (id: string) => (id === 'GOOGLE_CLOUD_TTS_CREDENTIALS' ? escaped : undefined) });
    } catch (error) {
      message = String((error as Error).message);
    }

    expect(message).toContain('GOOGLE_CLOUD_TTS_CREDENTIALS is neither a service-account key as a JSON object nor the path of an existing file');
    expect(message).not.toContain('demo+body');
    expect(message).not.toContain('demo-project');
  });
});
