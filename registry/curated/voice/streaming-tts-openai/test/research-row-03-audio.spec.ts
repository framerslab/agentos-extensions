import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAITTSSession } from '../src/OpenAITTSSession.js';
import { EventEmitter } from 'node:events';
import { TelephonyStreamTransport, TwilioMediaStreamParser } from '@framers/agentos/io/channels/telephony';
import type { TelephonyAudioChunk } from '@framers/agentos/io/channels/telephony/TelephonyStreamTransport';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const response = (marker: number) => new Response(new Uint8Array([marker, 0]), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe('ordered core synthesis events', () => {
  it('derives WAV duration from returned samples and reaches acknowledged core playback', async () => {
    const pcm = Buffer.alloc(640); const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(676, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(640, 40);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(Buffer.concat([header, pcm])))));
    class Socket extends EventEmitter {
      bufferedAmount = 0; sent: Array<Record<string, any>> = [];
      send(value: string | Buffer, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value.toString())); callback?.(); }
      close() { this.emit('close'); }
    }
    const socket = new Socket(); const transport = new TelephonyStreamTransport(socket,
      new TwilioMediaStreamParser({ protocol: 'carrier' }), { protocol: 'carrier', authorizeStart: () => true });
    socket.emit('message', JSON.stringify({ event: 'start', streamSid: 's', start: { callSid: 'c',
      customParameters: { token: 'fixture' }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
    const session = new OpenAITTSSession({ apiKey: 'fixture', format: 'wav' }, {});
    const chunks: TelephonyAudioChunk[] = []; const errors = vi.fn(); let acknowledged = false;
    let playback: Promise<void> = Promise.resolve();
    session.on('error', errors); session.on('audio', (chunk: TelephonyAudioChunk) => {
      chunks.push(chunk); playback = transport.sendAudio(chunk).then(() => { acknowledged = true; });
    });
    session.pushTokens('A sentence whose estimated speaking duration differs from the returned audio. ');
    await session.flush(); await vi.waitFor(() => expect(socket.sent.some((frame) => frame.event === 'mark')).toBe(true));
    expect(errors).not.toHaveBeenCalled(); expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ format: 'pcm', container: 'wav', sampleRate: 16000, durationMs: 20 });
    expect(Buffer.from(socket.sent.find((frame) => frame.event === 'media')!.media.payload, 'base64')).toHaveLength(160);
    expect(acknowledged).toBe(false);
    socket.emit('message', JSON.stringify({ event: 'mark', streamSid: 's', mark: socket.sent.find((frame) => frame.event === 'mark')!.mark }));
    await playback; expect(acknowledged).toBe(true); session.close(); transport.close();
  });
  it('starts the second request only after the first emitted its audio', async () => {
    let first!: (r: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { first = resolve; })).mockResolvedValue(response(2));
    vi.stubGlobal('fetch', fetcher);
    const session = new OpenAITTSSession({ apiKey: 'fixture', format: 'pcm' }, {});
    const core = vi.fn(), legacy = vi.fn(); const order: string[] = [];
    session.on('audio', (chunk) => { core(chunk); order.push(`audio:${chunk.audio[0]}`); });
    session.on('audio_chunk', legacy); session.on('flush_complete', () => order.push('flush'));
    session.pushTokens('First sentence. Second sentence. '); const drained = session.flush();
    await tick(); expect(fetcher).toHaveBeenCalledOnce(); expect(order).toEqual([]);
    first(response(1)); await drained;
    expect(order).toEqual(['audio:1', 'audio:2', 'flush']);
    expect(core.mock.calls.map(([c]) => c.audio)).toEqual(legacy.mock.calls.map(([c]) => c.audio));
    expect(core.mock.calls[0]![0]).toMatchObject({ format: 'pcm', sampleRate: 24000, durationMs: 1000 / 24000 });
    session.close();
  });
  it('does not emit completion for a failed synthesis batch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream body', { status: 429 })));
    const session = new OpenAITTSSession({ apiKey: 'fixture' }, {}); const error = vi.fn(), done = vi.fn();
    session.on('error', error); session.on('flush_complete', done);
    session.pushTokens('Failed sentence. '); await session.flush();
    expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0]![0].message).toContain('429');
    expect(error.mock.calls[0]![0].message).not.toContain('private upstream body'); expect(done).not.toHaveBeenCalled(); session.close();
  });
  it('cancels queued requests and suppresses an already admitted response', async () => {
    let first!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { first = resolve; })); vi.stubGlobal('fetch', fetcher);
    const session = new OpenAITTSSession({ apiKey: 'fixture' }, {}); const emitted = vi.fn();
    session.on('audio', emitted); session.on('audio_chunk', emitted); session.on('flush_complete', emitted);
    session.pushTokens('First sentence. Second sentence. '); const drained = session.flush(); await tick();
    session.cancel(); first(response(1)); await drained;
    expect(fetcher).toHaveBeenCalledOnce(); expect(emitted).not.toHaveBeenCalled();
  });
  it('retains legacy extra codecs and refuses them when a core audio consumer is present', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(1)); vi.stubGlobal('fetch', fetcher);
    const legacy = new OpenAITTSSession({ apiKey: 'fixture', format: 'flac' }, {}); const audio = vi.fn();
    legacy.on('audio_chunk', audio); legacy.pushTokens('Legacy. '); await legacy.flush(); expect(audio.mock.calls[0]![0].format).toBe('flac'); legacy.close();
    const core = new OpenAITTSSession({ apiKey: 'fixture', format: 'flac' }, {}); const error = vi.fn(), done = vi.fn();
    core.on('audio', audio); core.on('error', error); core.on('flush_complete', done); core.pushTokens('Core. '); await core.flush();
    expect(error).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce(); core.close();
  });
});
