/**
 * A run's publisher on LiveKit (`@livekit/rtc-node`): it joins the run's room when the run is accepted, publishes one
 * audio track only between `start()` and `suspend()`, a steady 20-millisecond frame by the wall clock with silence
 * where Zoom sends none, and sends each change of the active speaker as a text on the speaker topic, stamped with the
 * published audio's clock. Nothing is written to disk.
 *
 * @module
 */
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { ZOOM_SPEAKER_TOPIC, encodeSpeakerChange } from '../speakers.js';
import { FRAME_MS, FRAME_SAMPLES, FramePacer, SAMPLE_RATE } from './pacer.js';
import type { PublisherLike } from './publisher-like.js';
import { LifecycleSerial } from '@framers/agentos/io/channels/meetings';

/** A run's publisher on LiveKit (`@livekit/rtc-node`): it joins the run's room when the run is accepted and publishes one audio track only between `start()` and `suspend()`, a steady 20-millisecond frame by the wall clock with silence where Zoom sends none. */
export class LiveKitPublisher implements PublisherLike {
  private readonly lifecycle = new LifecycleSerial();
  private room: Room | undefined;
  private source: AudioSource | undefined;
  private track: LocalAudioTrack | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private due = 0;
  private readonly pacer = new FramePacer();
  publishing = false;

  constructor(private readonly livekit: { url: string; token: string }) {}

  async connect(): Promise<void> {
    this.room = new Room();
    await this.room.connect(this.livekit.url, this.livekit.token, { autoSubscribe: false, dynacast: false });
  }

  start(): Promise<void> {
    const stamp = this.lifecycle.stamp();
    return this.lifecycle.run(async () => {
      if (!this.lifecycle.allows(stamp) || this.publishing) return;
      if (this.room?.localParticipant === undefined) throw new Error('not connected');
      this.source = new AudioSource(SAMPLE_RATE, 1, 1_000);
      this.track = LocalAudioTrack.createAudioTrack('meeting', this.source);
      await this.room.localParticipant.publishTrack(this.track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
      // A suspension or end can arrive while publishTrack is pending.
      if (!this.lifecycle.allows(stamp)) { await this.unpublish(); return; }
      this.publishing = true;
      this.startedAt = Date.now();
      this.due = 0;
      this.timer = setInterval(() => this.tick(), FRAME_MS / 2);
    });
  }

  /** Sends every frame the wall clock says is due, so a late timer never slows the audio; after a long stall it catches up by a second at most. */
  private tick(): void {
    if (!this.publishing || this.source === undefined) return;
    const want = Math.floor((Date.now() - this.startedAt) / FRAME_MS);
    if (want - this.due > 50) this.due = want - 50;
    while (this.due < want) {
      this.due += 1;
      void this.source.captureFrame(new AudioFrame(this.pacer.next(), SAMPLE_RATE, 1, FRAME_SAMPLES)).catch(() => undefined);
    }
  }

  push(samples: Int16Array): void {
    if (this.publishing) this.pacer.push(samples);
  }

  speaker(name: string): void {
    if (!this.publishing || this.room?.localParticipant === undefined) return;
    void this.room.localParticipant.sendText(encodeSpeakerChange({ ms: this.pacer.clockMs, name }), { topic: ZOOM_SPEAKER_TOPIC }).catch(() => undefined);
  }

  suspend(): Promise<void> {
    this.lifecycle.invalidate();
    this.publishing = false;
    return this.lifecycle.run(() => this.unpublish());
  }

  private async unpublish(): Promise<void> {
    this.publishing = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.pacer.drain();
    if (this.track?.sid !== undefined && this.room?.localParticipant !== undefined) {
      await this.room.localParticipant.unpublishTrack(this.track.sid, true);
    }
    await this.source?.close();
    this.track = undefined;
    this.source = undefined;
  }

  close(): Promise<void> {
    this.lifecycle.invalidate(true);
    this.publishing = false;
    return this.lifecycle.run(async () => {
      await this.unpublish();
      await this.room?.disconnect();
      this.room = undefined;
    });
  }
}
