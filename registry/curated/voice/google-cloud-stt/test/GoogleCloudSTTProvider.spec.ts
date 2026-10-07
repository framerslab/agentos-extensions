// @ts-nocheck
/**
 * @file GoogleCloudSTTProvider.spec.ts
 * @description Unit tests for {@link GoogleCloudSTTProvider}.
 *
 * The `@google-cloud/speech` SDK is mocked via `vi.mock` so tests run without
 * a real GCP project or network connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePcmBuffer(seconds = 0.1, sampleRate = 16000): Buffer {
  // LINEAR16: 2 bytes per sample
  return Buffer.alloc(Math.round(seconds * sampleRate) * 2, 0);
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
    const provider = new GoogleCloudSTTProvider('/path/to/key.json');
    expect(provider.id).toBe('google-cloud-stt');
  });

  // 2. File-path credentials — uses keyFilename
  it('uses Application Default Credentials when no credentials are given', async () => {
    const provider = new GoogleCloudSTTProvider('');
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({});
  });

  it('passes keyFilename when credentials contain a path separator', async () => {
    const provider = new GoogleCloudSTTProvider('/tmp/service-account.json');
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0]!.options).toEqual({ keyFilename: '/tmp/service-account.json' });
  });

  // 3. JSON string credentials — uses credentials object
  it('parses JSON credentials when no path separator is present', async () => {
    const creds = { client_email: 'test@project.iam.gserviceaccount.com', private_key: 'key' };
    const provider = new GoogleCloudSTTProvider(JSON.stringify(creds));
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({ credentials: creds });
  });

  // 4. Windows-style path separator
  it('treats backslash-containing strings as file paths', async () => {
    const provider = new GoogleCloudSTTProvider('C:\\keys\\service-account.json');
    await provider.transcribe({ data: makePcmBuffer() });

    expect(mockInstances[0]!.options).toEqual({
      keyFilename: 'C:\\keys\\service-account.json',
    });
  });

  // 5. recognize() request shape
  it('calls recognize() with correct encoding, sampleRate and languageCode', async () => {
    const provider = new GoogleCloudSTTProvider('/path/key.json');
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
    const provider = new GoogleCloudSTTProvider('/path/key.json');
    await provider.transcribe({ data: makePcmBuffer() });

    const calls = mockInstances[0]!.recognizeCalls as Array<{
      config: { languageCode: string };
    }>;
    expect(calls[0]!.config.languageCode).toBe('en-US');
  });

  // 7. Default sampleRate is 16000
  it('defaults sampleRateHertz to 16000 when audio.sampleRate is omitted', async () => {
    const provider = new GoogleCloudSTTProvider('/path/key.json');
    await provider.transcribe({ data: makePcmBuffer() });

    const calls = mockInstances[0]!.recognizeCalls as Array<{
      config: { sampleRateHertz: number };
    }>;
    expect(calls[0]!.config.sampleRateHertz).toBe(16000);
  });

  // 8. Response mapping
  it('maps response alternatives to SpeechTranscriptionResult[]', async () => {
    const provider = new GoogleCloudSTTProvider('/path/key.json');
    const results = await provider.transcribe({ data: makePcmBuffer() });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ transcript: 'hello world', confidence: 0.97, isFinal: true });
    expect(results[1]).toEqual({ transcript: 'goodbye world', confidence: 0.73, isFinal: true });
  });

  // 9. isFinal is always true (batch provider)
  it('sets isFinal = true on every result', async () => {
    const provider = new GoogleCloudSTTProvider('/path/key.json');
    const results = await provider.transcribe({ data: makePcmBuffer() });

    expect(results.every((r) => r.isFinal)).toBe(true);
  });

  // 10. Empty results
  it('returns an empty array when the API returns no results', async () => {
    // Override the mock for this one test.
    vi.doMock('@google-cloud/speech', () => ({
      SpeechClient: class {
        async recognize() {
          return [{ results: [] }];
        }
      },
    }));

    // The provider lazily imports the client, so we need a fresh instance.
    // Since vi.doMock doesn't re-hoist, we verify the behaviour via the main
    // mock by simulating an empty results array returned by the default mock.
    // (We test this path indirectly: if results is empty the for-loop exits
    // without pushing, so the return value is [].)
    // For this test we use a provider with the already-registered mock and
    // override recognize to return empty.
    const provider = new GoogleCloudSTTProvider('/path/key.json');

    // Monkey-patch the lazy client on the instance via a crafted response.
    // Accessing private field via cast to bypass TS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any)._client = {
      recognize: async () => [{ results: [] }],
    };

    const results = await provider.transcribe({ data: makePcmBuffer() });
    expect(results).toEqual([]);
  });
});
