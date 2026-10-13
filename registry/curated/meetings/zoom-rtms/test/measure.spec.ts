import { describe, it, expect } from 'vitest';
import { rms, zeroCrossingHz } from '../src/capture/measure.js';

const sine = (hz: number, samples = 1_600, rate = 16_000, amplitude = 8_000) => Int16Array.from({ length: samples }, (_, i) => Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate)));

describe('the measures', () => {
  it('estimates a tone by its zero crossings', () => {
    expect(zeroCrossingHz(sine(440), 16_000)).toBeGreaterThan(420);
    expect(zeroCrossingHz(sine(440), 16_000)).toBeLessThan(460);
    expect(zeroCrossingHz(sine(1_000), 16_000)).toBeGreaterThan(950);
    expect(zeroCrossingHz(sine(1_000), 16_000)).toBeLessThan(1_050);
    expect(zeroCrossingHz(new Int16Array(320), 16_000)).toBe(0);
  });
  it('reads samples in the wrong byte order as noise', () => {
    const right = sine(440);
    const bytes = Buffer.from(right.buffer, right.byteOffset, right.byteLength);
    const wrong = Int16Array.from({ length: right.length }, (_, i) => bytes.readInt16BE(i * 2));
    expect(zeroCrossingHz(wrong, 16_000)).toBeGreaterThan(3_000);
  });
  it('measures level', () => {
    expect(rms(new Int16Array(320))).toBe(0);
    expect(rms(sine(440))).toBeGreaterThan(0.15);
    expect(rms(sine(440))).toBeLessThan(0.2);
  });
});
