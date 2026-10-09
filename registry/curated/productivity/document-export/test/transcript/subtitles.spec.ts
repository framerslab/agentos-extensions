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

  it('skips a turn with no time', () => {
    expect(toSrt({ ...SAMPLE, turns: [{ seq: 1, startMs: null, endMs: null, text: 'x' }] })).toBe('');
  });
});
