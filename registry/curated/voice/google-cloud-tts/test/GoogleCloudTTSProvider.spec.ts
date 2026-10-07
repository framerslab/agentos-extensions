// @ts-nocheck
/**
 * @file GoogleCloudTTSProvider.spec.ts
 * @description Unit tests for {@link GoogleCloudTTSProvider}.
 *
 * The `@google-cloud/text-to-speech` SDK is mocked via `vi.mock` so tests run
 * without a real GCP project or network connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleCloudTTSProvider', () => {
  beforeEach(() => {
    mockInstances.length = 0;
  });

  // 1. id
  it('exposes id = "google-cloud-tts"', () => {
    const provider = new GoogleCloudTTSProvider('/path/to/key.json');
    expect(provider.id).toBe('google-cloud-tts');
  });

  // 2. File-path credentials
  it('uses Application Default Credentials when no credentials are given', async () => {
    const provider = new GoogleCloudTTSProvider('');
    await provider.synthesize('hi');

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({});
  });

  it('passes keyFilename when credentials contain a forward slash', async () => {
    const provider = new GoogleCloudTTSProvider('/tmp/sa.json');
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ keyFilename: '/tmp/sa.json' });
  });

  // 3. JSON string credentials
  it('parses JSON credentials when no path separator is present', async () => {
    const creds = { client_email: 'tts@project.iam.gserviceaccount.com', private_key: 'key' };
    const provider = new GoogleCloudTTSProvider(JSON.stringify(creds));
    await provider.synthesize('hi');

    expect(mockInstances[0]!.options).toEqual({ credentials: creds });
  });

  // 4. synthesizeSpeech request shape — defaults
  it('calls synthesizeSpeech with MP3 encoding and default language', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
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
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    await provider.synthesize('Bonjour', { languageCode: 'fr-FR', voice: 'fr-FR-Neural2-A' });

    const calls = mockInstances[0]!.synthesizeCalls as Array<{
      voice: { languageCode: string; name: string };
    }>;
    expect(calls[0]!.voice.languageCode).toBe('fr-FR');
    expect(calls[0]!.voice.name).toBe('fr-FR-Neural2-A');
  });

  // 6. SynthesisResult shape
  it('returns audioBuffer, mimeType and cost', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    const result = await provider.synthesize('test');

    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.cost).toBe(0);
    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(result.audioBuffer).toEqual(FAKE_AUDIO);
  });

  // 7. audioBuffer is a real Buffer
  it('wraps the Uint8Array audioContent in a Buffer', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    const result = await provider.synthesize('test');

    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
  });

  // 8. listAvailableVoices — count
  it('returns all voices from listVoices response', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    const voices = await provider.listAvailableVoices();

    expect(voices).toHaveLength(3);
  });

  // 9. listAvailableVoices — voice shape
  it('maps voice fields to SpeechVoice', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    const voices = await provider.listAvailableVoices();

    expect(voices[0]).toEqual({
      id: 'en-US-Neural2-A',
      name: 'en-US-Neural2-A',
      languageCode: 'en-US',
      gender: 'FEMALE',
    });
  });

  // 10. listAvailableVoices — all language codes present
  it('includes voices for multiple language codes', async () => {
    const provider = new GoogleCloudTTSProvider('/path/key.json');
    const voices = await provider.listAvailableVoices();

    const codes = voices.map((v) => v.languageCode);
    expect(codes).toContain('fr-FR');
    expect(codes).toContain('en-US');
  });
});
