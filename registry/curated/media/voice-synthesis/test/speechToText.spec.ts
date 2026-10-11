// @ts-nocheck
/**
 * @fileoverview speech_to_text with fetch stubbed and AgentOS's guarded fetch
 * mocked: requests to each provider, audio URLs and the refusals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// AgentOS's guarded fetch, which reads an audioUrl; a case sets it to
// undefined for an AgentOS that has none.
const memory = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock('@framers/agentos/cognition/memory', () => memory);

// Clear env vars that affect provider detection
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_BASE_URL',
  'WHISPER_LOCAL_BASE_URL',
  'STT_PROVIDER',
];

const { SpeechToTextTool } = await import('../src/tools/speechToText.js');

describe('SpeechToTextTool', () => {
  const ctx = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  it('has correct id and name', () => {
    const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
    expect(tool.id).toBe('stt-multi-provider-v1');
    expect(tool.name).toBe('speech_to_text');
    expect(tool.hasSideEffects).toBe(false);
  });

  it('fails when no provider is configured', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: '' });
    const result = await tool.execute({ audioBase64: Buffer.from('wav').toString('base64') }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('OPENAI_API_KEY');
    expect(result.error).toContain('DEEPGRAM_API_KEY');
  });

  it('fails when no audio input is provided', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Provide either audioBase64 or audioUrl');
  });

  it('transcribes base64 audio through OpenAI Whisper', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue('application/json') },
      json: async () => ({ text: 'hello world', language: 'en', duration: 1.5, segments: [{ text: 'hello world', start: 0, end: 1.5 }] }),
    });

    const result = await tool.execute(
      {
        audioBase64: 'data:audio/wav;base64,' + Buffer.from('fake-audio').toString('base64'),
        responseFormat: 'verbose_json',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.text).toBe('hello world');
    expect(result.output!.language).toBe('en');
    expect(result.output!.provider).toBe('openai');
    expect(result.output!.segments).toHaveLength(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/audio/transcriptions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('auto-detects Deepgram when OpenAI is unavailable', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: '', deepgramApiKey: 'dg-test' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        metadata: { duration: 2.1 },
        results: {
          utterances: [
            {
              transcript: 'hello from deepgram',
              start: 0,
              end: 2.1,
              confidence: 0.98,
              speaker: 0,
              words: [{ word: 'hello', start: 0, end: 0.5, confidence: 0.9 }],
            },
          ],
          channels: [
            {
              alternatives: [
                {
                  transcript: 'hello from deepgram',
                  confidence: 0.98,
                  detected_language: 'en',
                },
              ],
            },
          ],
        },
      }),
    });

    const result = await tool.execute(
      {
        audioBase64: Buffer.from('fake-audio').toString('base64'),
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.provider).toBe('deepgram');
    expect(result.output!.language).toBe('en');
    expect(result.output!.segments).toHaveLength(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/listen?');
    expect(opts.headers.Authorization).toBe('Token dg-test');
  });

  it('uses Whisper-local when explicitly requested', async () => {
    const tool = new SpeechToTextTool({ whisperLocalBaseUrl: 'http://127.0.0.1:9000/v1' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue('application/json') },
      json: async () => ({
        text: 'local transcript',
        language: 'en',
        duration: 1.2,
      }),
    });

    const result = await tool.execute(
      {
        provider: 'whisper-local',
        audioBase64: Buffer.from('fake-audio').toString('base64'),
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.provider).toBe('whisper-local');
    expect(result.output!.text).toBe('local transcript');
    expect(mockFetch.mock.calls[0][0]).toContain('127.0.0.1:9000/v1/audio/transcriptions');
  });

  it('reads an audio URL through the guarded fetch, then transcribes it', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
    memory.guardedFetch.mockResolvedValueOnce({ url: 'https://example.com/audio.mp3', status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(12) });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue('text/plain') },
      text: async () => 'remote transcript',
    });

    const result = await tool.execute({ audioUrl: ' https://example.com/audio.mp3 ', responseFormat: 'text' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output!.text).toBe('remote transcript');
    expect(memory.guardedFetch).toHaveBeenCalledWith(
      'https://example.com/audio.mp3',
      expect.objectContaining({ maxBytes: 25 * 1024 * 1024, deadlineMs: 30_000, accept: expect.arrayContaining(['audio/mpeg', 'audio/wav']) }),
    );
    // The one plain fetch is the transcription: the audio was read through the guard.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/audio/transcriptions');
  });

  it('reads the names servers give audio and video files, and sends MPEG under its own extension', async () => {
    memory.guardedFetch.mockResolvedValueOnce({ url: 'https://example.com/lecture.mpeg', status: 200, contentType: 'video/mpeg', body: Buffer.alloc(12) });
    mockFetch.mockResolvedValueOnce({ ok: true, headers: { get: vi.fn().mockReturnValue('text/plain') }, text: async () => 'lecture transcript' });

    const result = await new SpeechToTextTool({ openaiApiKey: 'sk-test' }).execute({ audioUrl: 'https://example.com/lecture.mpeg', responseFormat: 'text' }, ctx);

    expect(memory.guardedFetch).toHaveBeenCalledWith(
      'https://example.com/lecture.mpeg',
      expect.objectContaining({
        accept: expect.arrayContaining(['video/mpeg', 'audio/x-aac', 'audio/aiff', 'audio/x-aiff', 'audio/3gpp', 'video/3gpp', 'video/quicktime', 'audio/x-ms-wma', 'audio/x-matroska']),
      }),
    );
    expect(result.output!.text).toBe('lecture transcript');
    expect(mockFetch.mock.calls[0][1].body.get('file').name).toBe('audio.mpeg');
  });

  it('reads Ogg a server labels application/ogg, and sends it as audio/ogg', async () => {
    const ogg = { url: 'https://example.com/a.ogg', status: 200, contentType: 'application/ogg', body: Buffer.alloc(12) };
    memory.guardedFetch.mockResolvedValueOnce(ogg).mockResolvedValueOnce(ogg);
    mockFetch
      .mockResolvedValueOnce({ ok: true, headers: { get: vi.fn().mockReturnValue('text/plain') }, text: async () => 'openai transcript' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'deepgram transcript', confidence: 0.9 }] }] } }),
      });

    const openai = await new SpeechToTextTool({ openaiApiKey: 'sk-test' }).execute({ audioUrl: 'https://example.com/a.ogg', responseFormat: 'text' }, ctx);
    const deepgram = await new SpeechToTextTool({ deepgramApiKey: 'dg-test' }).execute({ provider: 'deepgram', audioUrl: 'https://example.com/a.ogg' }, ctx);

    expect(memory.guardedFetch).toHaveBeenCalledWith('https://example.com/a.ogg', expect.objectContaining({ accept: expect.arrayContaining(['audio/ogg', 'application/ogg']) }));
    expect(openai.output!.text).toBe('openai transcript');
    const file = mockFetch.mock.calls[0][1].body.get('file');
    expect(file.name).toBe('audio.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(deepgram.output!.text).toBe('deepgram transcript');
    expect(mockFetch.mock.calls[1][1].headers['Content-Type']).toBe('audio/ogg');
  });

  it('gives one message for an address that is not public and one that does not resolve, and transcribes nothing', async () => {
    const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
    for (const reason of ['address', 'network']) {
      memory.guardedFetch.mockRejectedValueOnce(Object.assign(new Error(`refused (${reason}): 10.0.0.5`), { reason }));
      const result = await tool.execute({ audioUrl: 'http://db.corp.internal/a.wav' }, ctx);
      expect(result).toEqual({ success: false, error: 'audioUrl could not be read from a public network address.' });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ reason: 'status', status: 404 }, 'Audio download failed (404).'],
    [{ reason: 'size' }, 'The audio at audioUrl is larger than 26214400 bytes.'],
    [{ reason: 'type' }, 'audioUrl did not answer with audio.'],
    [{ reason: 'deadline' }, 'audioUrl took longer than 30 seconds to read.'],
    [{ reason: 'port' }, 'audioUrl must be on port 80 or 443.'],
  ])('says why a read of the audio URL stopped: %o', async (fields, message) => {
    memory.guardedFetch.mockRejectedValueOnce(Object.assign(new Error('refused'), fields));
    const result = await new SpeechToTextTool({ openaiApiKey: 'sk-test' }).execute({ audioUrl: 'https://example.com/a.wav' }, ctx);

    expect(result).toEqual({ success: false, error: message });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an audio URL on an AgentOS without the guarded fetch, and still takes base64', async () => {
    const guarded = memory.guardedFetch;
    memory.guardedFetch = undefined;
    try {
      const tool = new SpeechToTextTool({ openaiApiKey: 'sk-test' });
      const refused = await tool.execute({ audioUrl: 'https://example.com/a.wav' }, ctx);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('needs @framers/agentos 0.13.44 or later');
      expect(mockFetch).not.toHaveBeenCalled();

      mockFetch.mockResolvedValueOnce({ ok: true, headers: { get: vi.fn().mockReturnValue('text/plain') }, text: async () => 'inline transcript' });
      const inline = await tool.execute({ audioBase64: Buffer.from('fake-audio').toString('base64'), responseFormat: 'text' }, ctx);
      expect(inline.output!.text).toBe('inline transcript');
    } finally {
      memory.guardedFetch = guarded;
    }
  });

  it('respects STT_PROVIDER from the environment', async () => {
    process.env.STT_PROVIDER = 'deepgram';
    process.env.DEEPGRAM_API_KEY = 'dg-env';
    const tool = new SpeechToTextTool({});
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        metadata: { duration: 0.8 },
        results: {
          channels: [{ alternatives: [{ transcript: 'env transcript', confidence: 0.91 }] }],
        },
      }),
    });

    const result = await tool.execute({ audioBase64: Buffer.from('fake-audio').toString('base64') }, ctx);

    expect(result.success).toBe(true);
    expect(result.output!.provider).toBe('deepgram');
  });
});
