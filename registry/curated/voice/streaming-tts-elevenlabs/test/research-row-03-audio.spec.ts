import { describe, expect, it, vi } from 'vitest';
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1; readyState = 1; sent: string[] = [];
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  return { default: Socket };
});
import { ElevenLabsTTSSession } from '../src/ElevenLabsTTSSession.js';
type Socket = { sent: string[]; emit(name: string, ...args: unknown[]): void };
function fixture(open = true) {
  const session = new ElevenLabsTTSSession({ apiKey: 'fixture' }, {});
  const socket = (session as unknown as { ws: Socket }).ws;
  if (open) socket.emit('open');
  const json = (value: unknown) => socket.emit('message', Buffer.from(JSON.stringify(value)), false);
  return { session, socket, json };
}
describe('core WebSocket synthesis events', () => {
  it('decodes JSON audio and emits both names in wire order before one completion', async () => {
    const f = fixture(); const core = vi.fn(), legacy = vi.fn(); const order: string[] = [];
    f.session.on('audio', (chunk) => { core(chunk); order.push(`audio:${chunk.audio[0]}`); });
    f.session.on('audio_chunk', legacy); f.session.on('flush_complete', () => order.push('flush'));
    f.session.pushTokens('Hello '); f.session.pushTokens('world.'); await f.session.flush();
    expect(order).toEqual([]);
    expect(f.socket.sent.slice(1).map((value) => JSON.parse(value).text)).toEqual(['Hello ', 'world.', '']);
    f.json({ audio: Buffer.from([1]).toString('base64') });
    f.socket.emit('message', Buffer.from([2]), true);
    f.json({ isFinal: true, audio: null }); f.json({ isFinal: true });
    expect(order).toEqual(['audio:1', 'audio:2', 'flush']); expect(core).toHaveBeenCalledTimes(2);
    expect(core.mock.calls[0]![0]).toBe(legacy.mock.calls[0]![0]);
    expect(core.mock.calls[0]![0]).toMatchObject({ format: 'mp3', sampleRate: 44100 }); f.session.close();
  });
  it('does not mistake EOS enqueue or socket close for completed synthesis', async () => {
    const f = fixture(); const done = vi.fn(); f.session.on('flush_complete', done);
    await f.session.flush(); expect(done).not.toHaveBeenCalled(); f.socket.emit('close'); expect(done).not.toHaveBeenCalled();
  });
  it('cancels before open without sending credentials or queued text', async () => {
    const f = fixture(false); const audio = vi.fn(); f.session.on('audio', audio); f.session.on('audio_chunk', audio);
    f.session.pushTokens('Unsent'); f.session.cancel(); f.socket.emit('open');
    f.json({ audio: Buffer.from([1]).toString('base64') }); expect(f.socket.sent).toEqual([]); expect(audio).not.toHaveBeenCalled();
  });
  it('refuses malformed audio without echoing the server payload', () => {
    const f = fixture(); const error = vi.fn(), audio = vi.fn(); f.session.on('error', error); f.session.on('audio', audio);
    f.json({ audio: 'private payload?' }); expect(audio).not.toHaveBeenCalled();
    expect(error.mock.calls[0]![0].message).toBe('ElevenLabs audio envelope invalid'); f.session.close();
  });
});
