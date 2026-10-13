import { describe, it, expect } from 'vitest';
import { attachSpeakerTimeline, decodeSpeakerChange, encodeSpeakerChange, SpeakerTimeline, ZOOM_SPEAKER_TOPIC } from '../src/speakers.js';

describe('the speaker topic', () => {
  it('encodes and decodes a change, and refuses what is not one', () => {
    expect(decodeSpeakerChange(encodeSpeakerChange({ ms: 1_240, name: 'Speaker A' }))).toEqual({ ms: 1_240, name: 'Speaker A' });
    expect(decodeSpeakerChange('{"v":1,"ms":-1,"name":"Speaker A"}')).toBeUndefined();
    expect(decodeSpeakerChange('{"v":1,"ms":5,"name":""}')).toBeUndefined();
    expect(decodeSpeakerChange('{"v":2,"ms":5,"name":"Speaker A"}')).toBeUndefined();
    expect(decodeSpeakerChange('not json')).toBeUndefined();
    expect(decodeSpeakerChange(JSON.stringify({ v: 1, ms: 5, name: 'x'.repeat(201) }))).toBeUndefined();
  });
  it('answers who was speaking at a time: the last change at or before it', () => {
    const timeline = new SpeakerTimeline();
    expect(timeline.at(500)).toBeNull();
    timeline.add({ ms: 1_000, name: 'Speaker A' });
    timeline.add({ ms: 4_000, name: 'Speaker B' });
    timeline.add({ ms: 2_500, name: 'Cy' }); // out of order: kept in its place
    expect(timeline.at(999)).toBeNull();
    expect(timeline.at(1_000)).toBe('Speaker A');
    expect(timeline.at(2_499)).toBe('Speaker A');
    expect(timeline.at(3_000)).toBe('Cy');
    expect(timeline.at(9_000)).toBe('Speaker B');
    expect(timeline.at(null)).toBeNull();
    expect(timeline.at(undefined)).toBeNull();
  });
  it('keeps the newest changes only, and forgets on clear', () => {
    const timeline = new SpeakerTimeline(3);
    for (let i = 0; i < 5; i++) timeline.add({ ms: i * 1_000, name: `P${i}` });
    expect(timeline.at(500)).toBeNull(); // the oldest two were dropped
    expect(timeline.at(2_100)).toBe('P2');
    timeline.clear();
    expect(timeline.at(4_500)).toBeNull();
  });
  it("fills a timeline from the bot's text streams on the topic, and from nobody else's", async () => {
    const handlers = new Map<string, (reader: { readAll(): Promise<string> }, participant: { identity: string }) => void>();
    const room = {
      registerTextStreamHandler: (topic: string, handler: (reader: { readAll(): Promise<string> }, participant: { identity: string }) => void) => void handlers.set(topic, handler),
      unregisterTextStreamHandler: (topic: string) => void handlers.delete(topic),
    };
    const timeline = new SpeakerTimeline();
    const detach = attachSpeakerTimeline(room, timeline);
    const send = (text: string, identity: string) => handlers.get(ZOOM_SPEAKER_TOPIC)!({ readAll: async () => text }, { identity });
    send(encodeSpeakerChange({ ms: 100, name: 'Speaker A' }), 'bot');
    send(encodeSpeakerChange({ ms: 200, name: 'Mallory' }), 'someone-else');
    send('garbage', 'bot');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timeline.at(300)).toBe('Speaker A');
    detach();
    expect(handlers.size).toBe(0);
  });
});
