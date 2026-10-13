/**
 * Two measures of a run of samples, for the capture tool's summary and the contract test: its level, and a pitch
 * estimate from its zero crossings. Samples read in the wrong byte order cross zero about every other sample, so the
 * estimate tells the orders apart without a reference signal.
 *
 * @module
 */

/** The root mean square of the samples, from 0 to 1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32_768) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Half the zero crossings a second: a pure tone's frequency, and a high figure for noise. */
export function zeroCrossingHz(samples: Int16Array, sampleRate: number): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) if (samples[i - 1] < 0 !== samples[i] < 0) crossings += 1;
  return (crossings / 2) * (sampleRate / samples.length);
}
