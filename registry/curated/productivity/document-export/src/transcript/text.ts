/**
 * @fileoverview Markdown, plain text, JSON and an HTML fragment for a clipboard.
 * @module document-export/transcript/text
 */

import { xmlText } from './sanitize.js';
import { clock } from './times.js';
import type { ExportPackEntry, TranscriptExport } from './types.js';

/** The time of the turn a quote names, when the turn has one. */
function quoteTime(doc: TranscriptExport, seq: number): string {
  const turn = doc.turns.find((candidate) => candidate.seq === seq);
  return turn?.startMs != null ? ` (${clock(turn.startMs)})` : '';
}

/** A pack section as two blocks, its heading and its lines, or none when its list is empty. */
function entries(doc: TranscriptExport, heading: string, list: ExportPackEntry[], marks: boolean): string[] {
  if (list.length === 0) return [];
  const lines: string[] = [];
  for (const entry of list) {
    const owner = entry.owner ? ` (${entry.owner})` : '';
    lines.push(marks ? `- ${entry.text}${owner}` : `${entry.text}${owner}`);
    for (const quote of entry.quotes) {
      lines.push(marks ? `  > "${quote.text}"${quoteTime(doc, quote.seq)}` : `  "${quote.text}"${quoteTime(doc, quote.seq)}`);
    }
  }
  return [marks ? `## ${heading}` : heading.toUpperCase(), lines.join('\n')];
}

/**
 * The export as blocks with one blank line between each two. A text keeps its own line breaks, blank lines
 * included: only the breaks at a block's two ends are left out, so they do not widen the gap between two blocks.
 */
function write(doc: TranscriptExport, marks: boolean): string {
  const blocks: string[] = [marks ? `# ${doc.title}` : doc.title];
  const facts = [new Date(doc.startedAt).toUTCString()];
  if (doc.durationSeconds != null) {
    const minutes = Math.round(doc.durationSeconds / 60);
    facts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  if (doc.folder) facts.push(doc.folder);
  if (doc.tags && doc.tags.length > 0) facts.push(doc.tags.join(', '));
  blocks.push(facts.join(' | '));
  if (doc.pack?.summary) blocks.push(marks ? '## Summary' : 'SUMMARY', doc.pack.summary);
  if (doc.pack) {
    blocks.push(...entries(doc, 'Decisions', doc.pack.decisions, marks));
    blocks.push(...entries(doc, 'Action items', doc.pack.actionItems, marks));
    blocks.push(...entries(doc, 'Open questions', doc.pack.openQuestions, marks));
  }
  // A record with no turns (the pack and the notes copied alone) gets no empty heading, as in `toHtml`.
  if (doc.turns.length > 0) blocks.push(marks ? '## Transcript' : 'TRANSCRIPT');
  for (const turn of doc.turns) {
    const time = turn.startMs != null ? `[${clock(turn.startMs)}]` : '';
    const who = turn.speaker ? ` ${turn.speaker}:` : '';
    const head = `${time}${who}`.trim();
    const lines = [marks ? (head ? `**${head}** ${turn.text}` : turn.text) : head ? `${head} ${turn.text}` : turn.text];
    for (const check of (doc.checks ?? []).filter((candidate) => candidate.seq === turn.seq)) {
      lines.push(`  ${marks ? '- ' : ''}${check.label}: ${check.sentence} (${check.source}${check.licence ? `, ${check.licence.name}` : ''})`);
    }
    blocks.push(lines.join('\n'));
  }
  if (doc.notes) blocks.push(marks ? '## Notes' : 'NOTES', doc.notes);
  const kept = blocks.map((block) => block.replace(/^[\r\n]+|[\r\n]+$/g, '')).filter((block) => block.length > 0);
  return `${kept.join('\n\n').trimEnd()}\n`;
}

/** The export as Markdown. */
export function toMarkdown(doc: TranscriptExport): string {
  return write(doc, true);
}

/** The export as plain text. */
export function toPlainText(doc: TranscriptExport): string {
  return write(doc, false);
}

/**
 * Text for the HTML fragment: escaped by `xmlText`, each line break written as `<br>`, since HTML folds a line feed
 * into a space and a person's notes would run into one line.
 */
function htmlText(text: string): string {
  return xmlText(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

/**
 * The export as an HTML fragment for a clipboard: the title, the pack's sections with their quotes, the transcript
 * and the notes, every text escaped by `xmlText` and its line breaks written as `<br>`.
 */
export function toHtml(doc: TranscriptExport): string {
  const out: string[] = [`<h1>${htmlText(doc.title)}</h1>`];
  const list = (heading: string, items: ExportPackEntry[]): void => {
    if (items.length === 0) return;
    out.push(`<h2>${heading}</h2><ul>`);
    for (const entry of items) {
      const quotes = entry.quotes.map((quote) => `<blockquote>${htmlText(`"${quote.text}"${quoteTime(doc, quote.seq)}`)}</blockquote>`).join('');
      out.push(`<li>${htmlText(entry.owner ? `${entry.text} (${entry.owner})` : entry.text)}${quotes}</li>`);
    }
    out.push('</ul>');
  };
  if (doc.pack?.summary) out.push('<h2>Summary</h2>', `<p>${htmlText(doc.pack.summary)}</p>`);
  if (doc.pack) {
    list('Decisions', doc.pack.decisions);
    list('Action items', doc.pack.actionItems);
    list('Open questions', doc.pack.openQuestions);
  }
  if (doc.turns.length > 0) {
    out.push('<h2>Transcript</h2>');
    for (const turn of doc.turns) {
      const head = `${turn.startMs != null ? `[${clock(turn.startMs)}]` : ''}${turn.speaker ? ` ${turn.speaker}:` : ''}`.trim();
      out.push(`<p>${head ? `<strong>${htmlText(head)}</strong> ` : ''}${htmlText(turn.text)}</p>`);
    }
  }
  if (doc.notes) out.push('<h2>Notes</h2>', `<p>${htmlText(doc.notes)}</p>`);
  return out.join('');
}

/** Every record, with the format's name and version. */
export function toJson(doc: TranscriptExport): string {
  return `${JSON.stringify({ format: 'transcript-export', v: 1, ...doc }, null, 2)}\n`;
}
