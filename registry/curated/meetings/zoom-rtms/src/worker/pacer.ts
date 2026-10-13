/**
 * Cuts the samples Zoom sends into 20-millisecond frames and hands them out one a tick, silence when none waits: Zoom
 * sends no audio while nobody speaks, and a track that stops would end the transcriber's session. The count of frames
 * handed out is the published audio's clock, which the speaker topic stamps its changes with.
 *
 * @module
 */

/** The sample rate of the audio Zoom sends and the room takes: 16 kHz. */
export const SAMPLE_RATE = 16_000;
/** The length of one published frame, in milliseconds. */
export const FRAME_MS = 20;
/** The samples in one frame at {@link SAMPLE_RATE}. */
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Cuts the samples Zoom sends into 20-millisecond frames and hands them out one a tick, silence when none waits; the frames handed out are the published audio's clock. */
export class FramePacer {
  private carry = new Int16Array(0);
  private queue: Int16Array[] = [];
  /** Frames handed out since the first. */
  sent = 0;

  /** `maxQueued` frames wait at most (two seconds by default); beyond it the oldest go, so a burst never becomes a standing delay. */
  constructor(private readonly maxQueued = 100) {}

  push(samples: Int16Array): void {
    let buffer = samples;
    if (this.carry.length > 0) {
      buffer = new Int16Array(this.carry.length + samples.length);
      buffer.set(this.carry);
      buffer.set(samples, this.carry.length);
    }
    let offset = 0;
    while (buffer.length - offset >= FRAME_SAMPLES) {
      this.queue.push(buffer.slice(offset, offset + FRAME_SAMPLES));
      offset += FRAME_SAMPLES;
    }
    this.carry = buffer.slice(offset);
    if (this.queue.length > this.maxQueued) this.queue.splice(0, this.queue.length - this.maxQueued);
  }

  /** The next frame: the oldest waiting, or silence. */
  next(): Int16Array {
    this.sent += 1;
    return this.queue.shift() ?? new Int16Array(FRAME_SAMPLES);
  }

  /** Milliseconds of audio handed out or waiting: where a sound arriving now will sit on the published clock. */
  get clockMs(): number {
    return (this.sent + this.queue.length) * FRAME_MS;
  }

  /** Forgets what waits; the clock stands. */
  drain(): void {
    this.queue = [];
    this.carry = new Int16Array(0);
  }
}
