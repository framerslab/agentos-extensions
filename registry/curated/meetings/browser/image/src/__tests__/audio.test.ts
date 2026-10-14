import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the fakes saw. Each publish waits at a gate until the test answers it, as rtc-node's `publishTrack` waits for the
 * server's answer, so a test can call the publisher again while a start is in flight.
 */
const fake = vi.hoisted(() => ({
  /** The sid of each track published, in order. */
  published: [] as string[],
  /** The sid each unpublish named, in order. */
  unpublished: [] as string[],
  /** The capture processes spawned, in order. */
  spawned: [] as Array<{ killed: boolean }>,
  /** The publishes waiting for the server's answer. */
  gates: [] as Array<() => void>,
}));

vi.mock('@livekit/rtc-node', () => {
  let sids = 0;
  class AudioSource {
    constructor(..._config: number[]) {}
    async captureFrame(): Promise<void> {}
    async close(): Promise<void> {}
  }
  class AudioFrame {}
  class TrackPublishOptions {
    constructor(readonly init: object) {}
  }
  class LocalAudioTrack {
    /** rtc-node 1.1.0 reads a track's sid from its info: the FFI's provisional sid until `publishTrack` stamps the publication's. */
    readonly info = { sid: 'TR_unknown' };
    get sid(): string {
      return this.info.sid;
    }
    static createAudioTrack(_name: string, _source: AudioSource): LocalAudioTrack {
      return new LocalAudioTrack();
    }
  }
  class LocalParticipant {
    async publishTrack(track: LocalAudioTrack, _options: TrackPublishOptions): Promise<{ sid: string }> {
      await new Promise<void>((answer) => fake.gates.push(answer));
      const sid = `TR_${++sids}`;
      track.info.sid = sid;
      fake.published.push(sid);
      return { sid };
    }
    async unpublishTrack(sid: string, _stopOnUnpublish?: boolean): Promise<void> {
      fake.unpublished.push(sid);
    }
  }
  class Room {
    localParticipant: LocalParticipant | undefined;
    async connect(_url: string, _token: string, _options: object): Promise<void> {
      this.localParticipant = new LocalParticipant();
    }
    async disconnect(): Promise<void> {}
  }
  return { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource: { SOURCE_MICROPHONE: 2 } };
});

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  /** A capture process that writes nothing and remembers being killed. */
  class FakeCapture extends EventEmitter {
    readonly stdout = new PassThrough();
    killed = false;
    kill(): boolean {
      this.killed = true;
      return true;
    }
  }
  return {
    spawn: (): FakeCapture => {
      const capture = new FakeCapture();
      fake.spawned.push(capture);
      return capture;
    },
  };
});

vi.mock('pino', () => ({ default: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));

import { AudioPublisher } from '../audio.js';

/** Answers every publish waiting for the server. */
function answerPublishes(): void {
  for (const answer of fake.gates.splice(0)) answer();
}

async function connectedPublisher(): Promise<AudioPublisher> {
  const publisher = new AudioPublisher({ url: 'ws://livekit.test:7880', token: 'test-token-not-a-secret' });
  await publisher.connect();
  return publisher;
}

describe('the audio publisher', () => {
  beforeEach(() => {
    fake.published.length = 0;
    fake.unpublished.length = 0;
    fake.spawned.length = 0;
    fake.gates.length = 0;
  });

  it('publishes one track and starts one capture for two starts at once', async () => {
    const publisher = await connectedPublisher();
    const first = publisher.start();
    const second = publisher.start(); // a second startCapture while the first one's publish waits for the server
    answerPublishes();
    await Promise.all([first, second]);
    expect(fake.published).toHaveLength(1);
    expect(fake.spawned).toHaveLength(1);
    expect(publisher.isPublishing).toBe(true);
  });

  it('stops the track and the capture of a start that was in flight when suspend came', async () => {
    const publisher = await connectedPublisher();
    const starting = publisher.start();
    const suspending = publisher.suspend(); // a suspendCapture, or the fail-closed suspend, while the publish waits for the server
    answerPublishes();
    await Promise.all([starting, suspending]);
    expect(publisher.isPublishing).toBe(false);
    expect(fake.spawned.map((capture) => capture.killed)).toEqual([true]);
    expect(fake.unpublished).toEqual(fake.published);
  });
});
