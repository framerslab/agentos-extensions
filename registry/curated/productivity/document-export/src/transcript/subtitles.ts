/**
 * @fileoverview SRT and WebVTT from the turns' times. A turn with no start is left out; a turn with no end ends at
 * the next turn's start or two seconds after its own start, whichever comes first.
 * @module document-export/transcript/subtitles
 */

import { cueText, vttText } from './sanitize.js';
import { cueTime } from './times.js';
import type { ExportTurn, TranscriptExport } from './types.js';

type Cue = { start: number; end: number; text: string };

function cues(doc: TranscriptExport, escape: (text: string) => string): Cue[] {
  const timed = doc.turns.filter((turn): turn is ExportTurn & { startMs: number } => turn.startMs != null);
  return timed.map((turn, index) => {
    const next = timed[index + 1]?.startMs;
    const end = turn.endMs ?? (next !== undefined ? Math.min(next, turn.startMs + 2000) : turn.startMs + 2000);
    const who = turn.speaker ? `${turn.speaker}: ` : '';
    return { start: turn.startMs, end: Math.max(end, turn.startMs + 1), text: escape(`${who}${turn.text}`) };
  });
}

/** The timed turns as SubRip (`.srt`) cues, numbered from 1, each with its speaker's label when it has one. */
export function toSrt(doc: TranscriptExport): string {
  return cues(doc, cueText)
    .map((cue, index) => `${index + 1}\n${cueTime(cue.start, ',')} --> ${cueTime(cue.end, ',')}\n${cue.text}\n`)
    .join('\n');
}

/** The timed turns as a WebVTT (`.vtt`) file: the `WEBVTT` header, then one cue per turn with its text escaped. */
export function toVtt(doc: TranscriptExport): string {
  const body = cues(doc, vttText)
    .map((cue) => `${cueTime(cue.start, '.')} --> ${cueTime(cue.end, '.')}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
