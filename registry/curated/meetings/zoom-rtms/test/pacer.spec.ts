import { describe, it, expect } from 'vitest';
import { FRAME_SAMPLES, FramePacer } from '../src/worker/pacer.js';

describe('FramePacer', () => {
  it('cuts samples into 20-millisecond frames across pushes, in order', () => {
    const pacer = new FramePacer();
    pacer.push(Int16Array.from({ length: 500 }, (_, i) => i));
    pacer.push(Int16Array.from({ length: 140 }, (_, i) => 500 + i));
    const first = pacer.next();
    const second = pacer.next();
    expect(first.length).toBe(FRAME_SAMPLES);
    expect([first[0], first[319]]).toEqual([0, 319]);
    expect([second[0], second[319]]).toEqual([320, 639]);
  });
  it('answers silence when nothing waits, and still counts the frame', () => {
    const pacer = new FramePacer();
    const frame = pacer.next();
    expect(frame.length).toBe(FRAME_SAMPLES);
    expect(frame.every((sample) => sample === 0)).toBe(true);
    expect(pacer.sent).toBe(1);
  });
  it('tells where a sound arriving now will sit on the published clock', () => {
    const pacer = new FramePacer();
    expect(pacer.clockMs).toBe(0);
    pacer.next();
    pacer.next();
    pacer.push(new Int16Array(FRAME_SAMPLES * 3));
    expect(pacer.clockMs).toBe(100); // two frames sent, three waiting
  });
  it('keeps the newest frames when more wait than it holds, and forgets on drain', () => {
    const pacer = new FramePacer(2);
    pacer.push(Int16Array.from({ length: FRAME_SAMPLES * 4 }, (_, i) => Math.floor(i / FRAME_SAMPLES)));
    expect(pacer.next()[0]).toBe(2);
    expect(pacer.next()[0]).toBe(3);
    pacer.push(new Int16Array(FRAME_SAMPLES + 5).fill(7));
    pacer.drain();
    expect(pacer.next()[0]).toBe(0);
  });
});
