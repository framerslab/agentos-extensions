import { describe, it, expect } from 'vitest';
import { ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD, ZOOM_RTMS_BILLING_INCREMENT_SECONDS, zoomStreamingMicro, zoomStreamingReservationMicro } from '../src/prices.js';

describe("Zoom's streaming price", () => {
  it('is one cent a streaming minute for audio without Zoom\'s transcript', () => {
    expect(ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD).toBe(0.01);
  });
  it('defaults to the exported increment and rounds each stream up to whole minutes', () => {
    expect(ZOOM_RTMS_BILLING_INCREMENT_SECONDS).toBe(60);
    for (const [seconds, micro] of [[0, 0], [1, 10_000], [1.5, 10_000], [60, 10_000], [61, 20_000], [90, 20_000], [3_600, 600_000]] as const) {
      expect(zoomStreamingMicro(seconds)).toBe(zoomStreamingMicro(seconds, ZOOM_RTMS_BILLING_INCREMENT_SECONDS));
      expect(zoomStreamingMicro(seconds)).toBe(micro);
      expect(zoomStreamingMicro(seconds, 60)).toBe(micro);
    }
  });
  it('supports a one-second increment with whole micro-dollar rounding', () => {
    for (const [seconds, micro] of [[0, 0], [1, 167], [1.5, 333], [2, 333], [3, 500], [60, 10_000], [61, 10_167], [90, 15_000], [3_600, 600_000]] as const) {
      expect(zoomStreamingMicro(seconds, 1)).toBe(micro);
    }
  });
  it('keeps whole-minute reservation rounding independent of the settlement increment', () => {
    expect(zoomStreamingReservationMicro(0)).toBe(0);
    expect(zoomStreamingReservationMicro(1)).toBe(10_000);
    expect(zoomStreamingReservationMicro(61)).toBe(20_000);
  });
  it('refuses negative and nonfinite durations in both calculations', () => {
    for (const cost of [zoomStreamingMicro, zoomStreamingReservationMicro]) {
      for (const seconds of [-1, NaN, Infinity]) expect(() => cost(seconds)).toThrow();
    }
  });
  it('refuses a zero, negative or nonfinite settlement increment even for zero duration', () => {
    for (const increment of [0, -1, NaN, Infinity, -Infinity]) {
      for (const seconds of [0, 1]) expect(() => zoomStreamingMicro(seconds, increment)).toThrow(RangeError);
    }
  });
});
