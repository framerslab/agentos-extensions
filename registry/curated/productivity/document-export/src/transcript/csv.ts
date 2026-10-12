/**
 * @fileoverview The action items as CSV: a UTF-8 byte order mark, a header row, then one row per item with its first
 * quote, CRLF line ends.
 * @module document-export/transcript/csv
 */

import { csvField } from './sanitize.js';
import { clock, startsBySeq } from './times.js';
import type { TranscriptExport } from './types.js';

/**
 * The byte order mark, U+FEFF, which UTF-8 writes as the bytes EF BB BF. Excel opens a CSV file as UTF-8 when the
 * file starts with them; without them it can misread text outside ASCII, a person's name included.
 */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Action item, owner, its first quote and that quote's time, after a byte order mark. A reader that does not strip
 * the mark finds it in front of the first header.
 */
export function actionItemsCsv(doc: TranscriptExport): string {
  const starts = startsBySeq(doc.turns);
  const rows = [['Action item', 'Owner', 'Quote', 'Time']];
  for (const item of doc.pack?.actionItems ?? []) {
    const quote = item.quotes[0];
    const start = quote ? starts.get(quote.seq) : undefined;
    rows.push([item.text, item.owner ?? '', quote?.text ?? '', start != null ? clock(start) : '']);
  }
  return BYTE_ORDER_MARK + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
