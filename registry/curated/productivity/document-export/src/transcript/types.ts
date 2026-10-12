/**
 * @fileoverview What a transcript export holds. Times are milliseconds from the session's start; a turn's speaker
 * is the label the device holds, written only into files the person saves.
 * @module document-export/transcript/types
 */

/** One line of the transcript. */
export interface ExportTurn {
  seq: number;
  startMs: number | null;
  endMs: number | null;
  text: string;
  speaker?: string | null;
}

/** A quote a pack line rests on: the turn's number and the words. */
export interface ExportQuote {
  seq: number;
  text: string;
}

/** One line of a pack. */
export interface ExportPackEntry {
  text: string;
  owner?: string | null;
  quotes: ExportQuote[];
}

/** The after-session pack. */
export interface ExportPack {
  summary: string | null;
  decisions: ExportPackEntry[];
  actionItems: ExportPackEntry[];
  openQuestions: ExportPackEntry[];
}

/** A check shown beside a line: its words, its source's name and sentence, and the licence a public source carries. */
export interface ExportCheck {
  seq: number | null;
  label: string;
  source: string;
  sentence: string;
  url?: string;
  licence?: { name: string; url: string };
}

/** The whole export. */
export interface TranscriptExport {
  title: string;
  /** ISO 8601. */
  startedAt: string;
  durationSeconds: number | null;
  tags?: string[];
  folder?: string | null;
  notes?: string | null;
  pack?: ExportPack | null;
  checks?: ExportCheck[];
  turns: ExportTurn[];
}
