/**
 * @fileoverview The action items as CSV: a header row, then one row per item with its first quote, CRLF line ends.
 * @module document-export/transcript/csv
 */

import { csvField } from './sanitize.js';
import { clock } from './times.js';
import type { TranscriptExport } from './types.js';

/** Action item, owner, its first quote and that quote's time. */
export function actionItemsCsv(doc: TranscriptExport): string {
  const rows = [['Action item', 'Owner', 'Quote', 'Time']];
  for (const item of doc.pack?.actionItems ?? []) {
    const quote = item.quotes[0];
    const turn = quote ? doc.turns.find((candidate) => candidate.seq === quote.seq) : undefined;
    rows.push([item.text, item.owner ?? '', quote?.text ?? '', turn?.startMs != null ? clock(turn.startMs) : '']);
  }
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
