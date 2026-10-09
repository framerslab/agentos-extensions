import { describe, expect, it } from 'vitest';

import { toSrt, toVtt } from '../../src/transcript/subtitles.js';
import { SAMPLE } from './sample.js';

describe('the subtitle writers', () => {
  it('writes SRT cues numbered from 1, the end taken from the next start when a turn has none', () => {
    expect(toSrt(SAMPLE)).toBe(
      '1\n00:00:00,000 --> 00:00:02,000\nYou: Shall we start?\n\n' +
        '2\n00:01:05,000 --> 00:01:09,500\nOther: Yes, we grow the budget by ten percent.\n\n' +
        "3\n00:01:10,000 --> 00:01:12,000\nI'll send the slides.\n",
    );
  });

  it('writes VTT with its header and its escapes', () => {
    const vtt = toVtt({ ...SAMPLE, turns: [{ seq: 1, startMs: 3_723_004, endMs: 3_724_000, text: 'a --> b <c>' }] });
    expect(vtt).toBe('WEBVTT\n\n01:02:03.004 --> 01:02:04.000\na -> b &lt;c>\n');
  });

  it('ends a turn with no end at the next start when that comes within two seconds, else two seconds after its own', () => {
    const turns = [
      { seq: 1, startMs: 0, endMs: null, text: 'a' },
      { seq: 2, startMs: 500, endMs: null, text: 'b' },
      { seq: 3, startMs: 10_000, endMs: 11_000, text: 'c' },
    ];
    expect(toSrt({ ...SAMPLE, turns })).toBe(
      '1\n00:00:00,000 --> 00:00:00,500\na\n\n' +
        '2\n00:00:00,500 --> 00:00:02,500\nb\n\n' +
        '3\n00:00:10,000 --> 00:00:11,000\nc\n',
    );
  });

  it('lists the cues by their start, turns with the same start in the order given, and leaves the turns as they were', () => {
    const turns = [
      { seq: 1, startMs: 500, endMs: null, text: 'b' },
      { seq: 2, startMs: 4_000, endMs: 5_000, text: 'c' },
      { seq: 3, startMs: 0, endMs: null, text: 'a' },
      { seq: 4, startMs: 4_000, endMs: 4_500, text: 'd' },
    ];
    // 'a' has no end and stops at the next start, 'b' at 500 ms, which is not the turn after it in the array.
    expect(toSrt({ ...SAMPLE, turns })).toBe(
      '1\n00:00:00,000 --> 00:00:00,500\na\n\n' +
        '2\n00:00:00,500 --> 00:00:02,500\nb\n\n' +
        '3\n00:00:04,000 --> 00:00:05,000\nc\n\n' +
        '4\n00:00:04,000 --> 00:00:04,500\nd\n',
    );
    expect(toVtt({ ...SAMPLE, turns })).toBe(
      'WEBVTT\n\n' +
        '00:00:00.000 --> 00:00:00.500\na\n\n' +
        '00:00:00.500 --> 00:00:02.500\nb\n\n' +
        '00:00:04.000 --> 00:00:05.000\nc\n\n' +
        '00:00:04.000 --> 00:00:04.500\nd\n',
    );
    expect(turns.map((turn) => turn.text)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('skips a turn with no time', () => {
    expect(toSrt({ ...SAMPLE, turns: [{ seq: 1, startMs: null, endMs: null, text: 'x' }] })).toBe('');
  });
});
