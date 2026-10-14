/**
 * Zoom's price for a Realtime Media Streams streaming minute of audio without Zoom's own transcription, on the Developer
 * Pack: a host prices a run's streaming time with it beside its transcriber's price.
 *
 * @module
 */

/** US dollars a streaming minute, audio without transcription. */
export const ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD = 0.01;

/**
 * Until credit-rate terms or comparison with the supplier's usage report establish its billing increment, settle each
 * stream rounded up to whole minutes. This bounds rounding by increments that divide a minute evenly, so the day's
 * spend cap does not count less than the supplier bills under that policy. Other increments, minimum billed duration
 * and aggregation require verification before accepting the price.
 */
export const ZOOM_RTMS_BILLING_INCREMENT_SECONDS = 60;

/** Micro-dollars a streaming minute, from {@link ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD}, so the two cannot drift. */
const MICRO_PER_MINUTE = Math.round(ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD * 1_000_000);

/** Conservative reservation liability; this rounding is not a claim about supplier billing. */
export function zoomStreamingReservationMicro(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('seconds must be finite and nonnegative');
  return Math.ceil(seconds / 60) * MICRO_PER_MINUTE;
}

/** Round each measured stream up to billing increments, then price it to the nearest whole micro-dollar. */
export function zoomStreamingMicro(seconds: number, incrementSeconds = ZOOM_RTMS_BILLING_INCREMENT_SECONDS): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('seconds must be finite and nonnegative');
  if (!Number.isFinite(incrementSeconds) || incrementSeconds <= 0) throw new RangeError('incrementSeconds must be finite and positive');
  const billedSeconds = Math.ceil(seconds / incrementSeconds) * incrementSeconds;
  return Math.round(billedSeconds * MICRO_PER_MINUTE / 60);
}
