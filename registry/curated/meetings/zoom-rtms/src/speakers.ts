/**
 * The active speaker beside the audio. Mixed audio names nobody, so the media worker sends each change of the active
 * speaker as a small text on a topic of the run's room, stamped with the published audio's own clock (milliseconds of
 * audio published before it), and whoever transcribes the room's audio keeps a timeline of the changes and asks it who
 * was speaking when a turn began. A speaker's name is content: it travels and rests with the transcript and is purged
 * with it. The room is taken by shape, so this module imports no media library.
 *
 * @module
 */

/** The topic the media worker publishes speaker changes on. */
export const ZOOM_SPEAKER_TOPIC = 'zoom-rtms.speaker';

/** A change of the active speaker, stamped with the milliseconds of audio published before it. */
export interface SpeakerChange {
  /** Milliseconds of audio published before this speaker became active. */
  ms: number;
  name: string;
}

/** The text sent on the speaker topic for a change: one line of JSON with a version, the milliseconds and the name. */
export function encodeSpeakerChange(change: SpeakerChange): string {
  return JSON.stringify({ v: 1, ms: Math.max(0, Math.round(change.ms)), name: change.name });
}

/** A change from a text on the topic, or undefined for anything else. */
export function decodeSpeakerChange(text: string): SpeakerChange | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const { v, ms, name } = json as { v?: unknown; ms?: unknown; name?: unknown };
  if (v !== 1 || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  if (typeof name !== 'string' || name === '' || name.length > 200) return undefined;
  return { ms, name };
}

/** Who was speaking when: the newest changes, in order of their time. */
export class SpeakerTimeline {
  private changes: SpeakerChange[] = [];

  constructor(private readonly keep = 2_000) {}

  add(change: SpeakerChange): void {
    let i = this.changes.length;
    while (i > 0 && this.changes[i - 1].ms > change.ms) i -= 1;
    this.changes.splice(i, 0, change);
    if (this.changes.length > this.keep) this.changes.splice(0, this.changes.length - this.keep);
  }

  /** The speaker active at a time on the audio's clock: the last change at or before it, or null. */
  at(ms: number | null | undefined): string | null {
    if (ms === null || ms === undefined) return null;
    let found: string | null = null;
    for (const change of this.changes) {
      if (change.ms > ms) break;
      found = change.name;
    }
    return found;
  }

  clear(): void {
    this.changes = [];
  }
}

/** What the timeline needs of a room: LiveKit's text stream handlers, as rtc-node's `Room` has them. */
export interface SpeakerRoomLike {
  registerTextStreamHandler(topic: string, callback: (reader: { readAll(): Promise<string> }, participant: { identity: string }) => void): void;
  unregisterTextStreamHandler?(topic: string): void;
}

/** Fills a timeline from the texts one identity publishes on the topic; answers the function that stops it. */
export function attachSpeakerTimeline(room: SpeakerRoomLike, timeline: SpeakerTimeline, fromIdentity = 'bot'): () => void {
  room.registerTextStreamHandler(ZOOM_SPEAKER_TOPIC, (reader, participant) => {
    if (participant.identity !== fromIdentity) return;
    void reader
      .readAll()
      .then((text) => {
        const change = decodeSpeakerChange(text);
        if (change !== undefined) timeline.add(change);
      })
      .catch(() => undefined);
  });
  return () => room.unregisterTextStreamHandler?.(ZOOM_SPEAKER_TOPIC);
}
