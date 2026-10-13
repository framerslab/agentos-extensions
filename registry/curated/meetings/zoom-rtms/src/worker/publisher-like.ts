/**
 * What the worker needs of a run's publisher. The worker's server takes it by this shape, so the server and its tests
 * load no media library; `publisher.ts` implements it on LiveKit.
 *
 * @module
 */
export interface PublisherLike {
  /** Joins the run's room. Nothing is published yet. */
  connect(): Promise<void>;
  /** Publishes the track: what is pushed from now on is heard. */
  start(): Promise<void>;
  /** Unpublishes the track; the room stays joined for a resume. */
  suspend(): Promise<void>;
  /** The meeting's mixed audio, 16 kHz mono. Dropped unless publishing. */
  push(samples: Int16Array): void;
  /** The active speaker's name. Dropped unless publishing. */
  speaker(name: string): void;
  readonly publishing: boolean;
  /** Unpublishes and leaves the room. */
  close(): Promise<void>;
}
