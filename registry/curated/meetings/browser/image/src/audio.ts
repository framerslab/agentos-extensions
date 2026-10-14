import { spawn, type ChildProcess } from 'node:child_process';
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { errorCode, log } from './log.js';

const SAMPLE_RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Reads the meeting sink's monitor with parec and publishes it as the bot's microphone track. Nothing is written to disk. */
export class AudioPublisher {
  private room: Room | undefined;
  private source: AudioSource | undefined;
  private track: LocalAudioTrack | undefined;
  private parec: ChildProcess | undefined;
  private publishing = false;

  /** @param livekit - The run's room: the LiveKit server's url and the token that lets the bot publish into it. */
  constructor(private readonly livekit: { url: string; token: string }) {}

  /** Joins the run's room without publishing anything and without subscribing to anyone. */
  async connect(): Promise<void> {
    this.room = new Room();
    await this.room.connect(this.livekit.url, this.livekit.token, { autoSubscribe: false, dynacast: false });
  }

  /** Publishes the track and starts the capture. The track is published only here: before `startCapture`, no audio leaves the container. */
  async start(): Promise<void> {
    if (!this.room) throw new Error('not_connected');
    if (this.publishing) return;
    this.source = new AudioSource(SAMPLE_RATE, 1, 1000);
    this.track = LocalAudioTrack.createAudioTrack('meeting', this.source);
    const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
    await this.room.localParticipant!.publishTrack(this.track, options);
    const parec = spawn('parec', ['--device=meeting.monitor', '--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1', '--raw', '--latency-msec=20'], { stdio: ['ignore', 'pipe', 'inherit'] });
    this.parec = parec;
    // a capture that cannot start or that ends while publishing leaves the track silent: the line says why
    parec.on('error', (err) => log.warn('step_failed', { phase: 'call', reason: 'parec', code: errorCode(err) }));
    parec.on('exit', (code) => {
      if (this.parec === parec && this.publishing) log.warn('step_failed', { phase: 'call', reason: 'parec_exit', exitCode: code ?? -1 });
    });
    this.publishing = true;
    let carry: Buffer = Buffer.alloc(0);
    parec.stdout!.on('data', (chunk: Buffer) => {
      let buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const frameBytes = FRAME_SAMPLES * 2;
      while (buf.length >= frameBytes && this.publishing && this.source) {
        const slice = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        const samples = new Int16Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + frameBytes));
        void this.source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SAMPLES)).catch(() => undefined); // a frame the closing source refuses is one frame
      }
      carry = Buffer.from(buf);
    });
  }

  /** Whether the track is published and the capture running. */
  get isPublishing(): boolean {
    return this.publishing;
  }

  /** Unpublishes the track and stops the capture; the room stays connected for a resume. */
  async suspend(): Promise<void> {
    if (!this.publishing) return;
    this.publishing = false;
    this.parec?.kill('SIGTERM');
    this.parec = undefined;
    if (this.track && this.room?.localParticipant) {
      await this.room.localParticipant.unpublishTrack(this.track.sid!, true).catch((err: unknown) => log.warn('step_failed', { phase: 'call', reason: 'unpublish', code: errorCode(err) }));
    }
    await this.source?.close();
    this.track = undefined;
    this.source = undefined;
  }

  /** Stops the capture and leaves the room. */
  async close(): Promise<void> {
    await this.suspend();
    await this.room?.disconnect();
    this.room = undefined;
  }
}
