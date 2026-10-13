import { beforeEach, expect, it, vi } from 'vitest';
const held = vi.hoisted(() => ({
  publish: vi.fn(), unpublish: vi.fn(), disconnect: vi.fn(), frames: vi.fn(), text: vi.fn(),
}));
vi.mock('@livekit/rtc-node', () => ({
  Room: class {
    localParticipant = { publishTrack: held.publish, unpublishTrack: held.unpublish, sendText: held.text };
    connect = async () => undefined;
    disconnect = held.disconnect;
  },
  AudioSource: class { captureFrame = held.frames; close = async () => undefined; },
  AudioFrame: class {},
  LocalAudioTrack: { createAudioTrack: () => ({ sid: 'track-1' }) },
  TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 },
}));
import { LiveKitPublisher } from '../src/worker/publisher.js';

beforeEach(() => {
  vi.clearAllMocks();
  held.frames.mockResolvedValue(undefined);
  held.unpublish.mockResolvedValue(undefined);
  held.disconnect.mockResolvedValue(undefined);
});
it.each(['suspend', 'close'] as const)('unpublishes a pending start when %s fences it', async (ending) => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  held.publish.mockImplementationOnce(() => { entered(); return new Promise<void>((resolve) => { release = resolve; }); });
  const publisher = new LiveKitPublisher({ url: 'ws://room.test', token: 'fixture' });
  await publisher.connect();
  const starting = publisher.start();
  await ready;
  const stopped = publisher[ending]();
  release();
  await Promise.all([starting, stopped]);
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(publisher.publishing).toBe(false);
  expect(held.unpublish).toHaveBeenCalledWith('track-1', true);
  expect(held.frames).not.toHaveBeenCalled();
  if (ending === 'close') {
    await publisher.start();
    expect(held.publish).toHaveBeenCalledTimes(1);
    expect(held.disconnect).toHaveBeenCalledOnce();
  }
  await publisher.close();
});
