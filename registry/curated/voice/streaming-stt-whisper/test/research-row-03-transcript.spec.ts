import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhisperChunkSession } from '../src/WhisperChunkSession.js';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = (count: number) => ({ samples: new Float32Array(count), sampleRate: 16000, timestamp: 0 });
const response = (text: string) => new Response(JSON.stringify({ text, duration: 0.01, segments: [] }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe('core transcript event compatibility', () => {
  it('awaits the HTTP result and preserves legacy aliases with the same payload', async () => {
    let complete!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    const session = new WhisperChunkSession({ apiKey: 'fixture', chunkSizeSamples: 16, overlapSamples: 0 });
    const core = vi.fn(), interim = vi.fn(), final = vi.fn();
    session.on('transcript', core); session.on('interim_transcript', interim); session.on('final_transcript', final);
    session.pushAudio(frame(8)); let drained = false; const pending = session.flush().then(() => { drained = true; });
    await tick(); expect(drained).toBe(false); expect(core).not.toHaveBeenCalled();
    complete(response('actual audio')); await pending;
    expect(core.mock.calls.map(([event]) => event.isFinal)).toEqual([false, true]);
    expect(core.mock.calls[0]![0]).toBe(interim.mock.calls[0]![0]);
    expect(core.mock.calls[1]![0]).toBe(final.mock.calls[0]![0]);
    expect(final.mock.calls[0]![0].text).toBe('actual audio'); session.close();
  });
  it('serializes requests and forwards only a completed prompt to the next chunk', async () => {
    let first!: (r: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { first = resolve; })).mockResolvedValue(response('second'));
    vi.stubGlobal('fetch', fetcher);
    const session = new WhisperChunkSession({ apiKey: 'fixture', chunkSizeSamples: 8, overlapSamples: 0 });
    const legacy = vi.fn(); session.on('interim_transcript', legacy);
    session.pushAudio(frame(16)); await tick(); expect(fetcher).toHaveBeenCalledOnce();
    first(response('first')); await session.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[1]![1].body as FormData).get('prompt')).toBe('first');
    expect(legacy.mock.calls.map(([event]) => event.text)).toEqual(['first', 'second']); session.close();
  });
  it('never turns the seed prompt into a transcript or emits after close', async () => {
    const empty = new WhisperChunkSession({ apiKey: 'fixture', prompt: 'context only' });
    const transcript = vi.fn(); empty.on('transcript', transcript); await empty.flush(); expect(transcript).not.toHaveBeenCalled(); empty.close();
    let complete!: (r: Response) => void;
    const fetcher = vi.fn((_url, init: RequestInit) => new Promise<Response>((resolve) => { complete = resolve; })); vi.stubGlobal('fetch', fetcher);
    const session = new WhisperChunkSession({ apiKey: 'fixture', chunkSizeSamples: 8, overlapSamples: 0 });
    session.on('transcript', transcript); session.on('interim_transcript', transcript); session.on('final_transcript', transcript);
    session.pushAudio(frame(8)); await tick(); session.close();
    expect((fetcher.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
    complete(response('too late')); await tick(); expect(transcript).not.toHaveBeenCalled();
  });
  it('discards a failed batch transcript instead of finalizing it on the next flush', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => response('partial')).mockImplementation(async () => new Response('upstream', { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    const session = new WhisperChunkSession({ apiKey: 'fixture', chunkSizeSamples: 8, overlapSamples: 0 });
    const core = vi.fn(), final = vi.fn(), error = vi.fn();
    session.on('transcript', core); session.on('final_transcript', final); session.on('error', error);
    session.pushAudio(frame(16)); await session.flush(); await session.flush();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledOnce();
    expect(core.mock.calls.map(([event]) => [event.text, event.isFinal])).toEqual([['partial', false]]);
    expect(final).not.toHaveBeenCalled(); session.close();
  });
  it('keeps recognizing after error delivery throws and rejects one flush with that exception', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response('upstream', { status: 500 })).mockImplementation(async () => response('recovered'));
    vi.stubGlobal('fetch', fetcher);
    const session = new WhisperChunkSession({ apiKey: 'fixture', chunkSizeSamples: 8, overlapSamples: 0 });
    const final = vi.fn(); session.on('final_transcript', final);
    session.pushAudio(frame(8)); await expect(session.flush()).rejects.toThrow('Whisper API error 500');
    session.pushAudio(frame(8)); await session.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(final.mock.calls.map(([event]) => event.text)).toEqual(['recovered']); session.close();
  });
});
