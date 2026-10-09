# Document Export

Generate PDF, DOCX, PPTX, CSV and XLSX documents from an agent's structured content. A second entry, `./transcript`, writes a transcript as Markdown, plain text, JSON, CSV, SRT, VTT, DOCX, an HTML fragment or a zip, and runs in a browser as well as in Node.

## Installation

```bash
npm install @framers/agentos-ext-document-export
```

## The extension pack

```typescript
import { createExtensionPack } from '@framers/agentos-ext-document-export';

const pack = createExtensionPack({ options: { workspaceDir: '/srv/agent' } });
```

| Tool | What it does |
|---|---|
| `document_export` | Renders structured content (sections with paragraphs, tables, charts and images) to `pdf`, `docx`, `pptx`, `csv` or `xlsx`, saves the file under `<workspaceDir>/exports/` and answers its download and preview links |
| `document_suggest` | Reads a reply's length, tables and sections and says whether to offer an export, and in which formats, with no model call |

Options: `workspaceDir` (default: the process's working folder), `serverPort` (default 3777), `publicBaseUrl` and `priority` (default 50). This entry runs in Node: it writes files to disk and renders PDF with pdfkit.

## Transcript exports (browser-safe)

`@framers/agentos-ext-document-export/transcript` writes a transcript with its times, an after-session pack whose lines carry their quotes, and the checks shown beside the lines. It imports nothing but [fflate](https://github.com/101arrowz/fflate) and never touches a file system: each writer answers a string or bytes, and the caller saves them.

```typescript
import type { TranscriptExport } from '@framers/agentos-ext-document-export/transcript';

const doc: TranscriptExport = {
  title: 'Budget review',
  startedAt: '2026-10-08T14:05:00.000Z',
  durationSeconds: 754,
  tags: ['q3'],
  pack: {
    summary: 'The team agreed the budget.',
    decisions: [{ text: 'Budget grows ten percent.', quotes: [{ seq: 2, text: 'we grow the budget by ten percent' }] }],
    actionItems: [{ text: 'Send the slides.', owner: 'Ann', quotes: [{ seq: 3, text: "I'll send the slides" }] }],
    openQuestions: [],
  },
  checks: [{ seq: 2, label: 'Matches your notes', source: 'Note: Budget', sentence: 'Budget up ten percent.' }],
  turns: [
    { seq: 1, startMs: 0, endMs: 2_000, text: 'Shall we start?', speaker: 'You' },
    { seq: 2, startMs: 65_000, endMs: 69_500, text: 'Yes, we grow the budget by ten percent.', speaker: 'Other' },
    { seq: 3, startMs: 70_000, endMs: null, text: "I'll send the slides." },
  ],
};
```

Times are milliseconds from the session's start. A quote names its turn by `seq`, and the writers print that turn's time beside it. A turn's `speaker` is optional and is printed when present.

| Writer | Answers |
|---|---|
| `toMarkdown(doc)` | Markdown: the title, a line of facts, the summary, the decisions, action items and open questions with their quotes, the transcript with times and speakers, each check under its line, and the notes |
| `toPlainText(doc)` | The same without Markdown marks |
| `toJson(doc)` | Every record, with `format: 'transcript-export'` and `v: 1` |
| `toHtml(doc)` | An HTML fragment for a clipboard: the title, the pack with its quotes, the transcript and the notes, each line break written as `<br>` |
| `actionItemsCsv(doc)` | The action items as CSV: the item, its owner, its first quote and that quote's time, after a UTF-8 byte order mark |
| `toSrt(doc)` | SubRip cues, listed by their start and numbered from 1 |
| `toVtt(doc)` | A WebVTT file, its cues listed by their start |
| `toDocx(doc)` | The bytes of a Word document with headings, paragraphs and quotes, each line break written as `<w:br/>` and each tab as `<w:tab/>` |
| `writeArchive(entries)`, `readArchive(bytes)` | A zip of several files, and its entries read back in their order |

In the Markdown, plain-text, HTML and Word writers a section with nothing in it is left out: the summary's heading needs a summary, a list its entries, the notes' heading some notes and the transcript's heading a turn, so `{ ...doc, turns: [] }` writes the record without a transcript section.

One example per writer, on the record above:

```typescript
import {
  actionItemsCsv,
  readArchive,
  toDocx,
  toHtml,
  toJson,
  toMarkdown,
  toPlainText,
  toSrt,
  toVtt,
  writeArchive,
} from '@framers/agentos-ext-document-export/transcript';

toMarkdown(doc);
// # Budget review
//
// Thu, 08 Oct 2026 14:05:00 GMT | 13 minutes | q3
//
// ## Summary
//
// The team agreed the budget.
//
// ## Decisions
//
// - Budget grows ten percent.
//   > "we grow the budget by ten percent" (01:05)
// ...
// **[01:05] Other:** Yes, we grow the budget by ten percent.
//   - Matches your notes: Budget up ten percent. (Note: Budget)

toPlainText(doc);
// ...
// [01:05] Other: Yes, we grow the budget by ten percent.
//   Matches your notes: Budget up ten percent. (Note: Budget)

JSON.parse(toJson(doc)).format;
// 'transcript-export'

toHtml(doc);
// '<h1>Budget review</h1><h2>Summary</h2><p>The team agreed the budget.</p><h2>Decisions</h2><ul><li>...'

actionItemsCsv(doc);
// U+FEFF, the byte order mark, then:
// "Action item","Owner","Quote","Time"
// "Send the slides.","Ann","I'll send the slides","01:10"

toSrt(doc);
// 1
// 00:00:00,000 --> 00:00:02,000
// You: Shall we start?
// ...

toVtt(doc);
// WEBVTT
//
// 00:00:00.000 --> 00:00:02.000
// You: Shall we start?
// ...

const docx: Uint8Array = toDocx(doc);

const zip = writeArchive([
  { path: 'sessions/budget-review.md', data: toMarkdown(doc) },
  { path: 'sessions/budget-review.docx', data: docx },
]);
readArchive(zip).map((entry) => entry.path);
// ['sessions/budget-review.md', 'sessions/budget-review.docx']
```

The CSV starts with a byte order mark (U+FEFF, the bytes EF BB BF once encoded as UTF-8): [Excel opens a UTF-8 CSV file normally when it was saved with one](https://support.microsoft.com/en-us/office/opening-csv-utf-8-files-correctly-in-excel-8a935af5-3416-4edd-ba7e-3dfd2bc4a032), and without one it can misread text outside ASCII, a person's name included. A reader that does not strip the mark finds it in front of the first header.

The subtitles leave out a turn with no start and list the cues by their start, whatever the order of the turns: [WebVTT requires](https://www.w3.org/TR/webvtt1/#webvtt-cue-timings) each cue to start no earlier than the cues before it. Turns with the same start keep their order. A turn with no end ends at the next cue's start or two seconds after its own start, whichever comes first.

What each format is guarded against, with the helper the entry exports:

- XML and HTML text (`xmlText`): characters outside XML 1.0's `Char` production are dropped, and `&`, `<`, `>`, `"` and `'` are escaped.
- A WebVTT cue (`vttText`): `&` and `<` are escaped, every `-->` is broken, and no blank line is left inside the cue. An SRT cue (`cueText`) keeps no blank line inside.
- A CSV field (`csvField`): every field is quoted with its quotes doubled, and a field that starts with `=`, `+`, `-`, `@`, a tab, a carriage return, a line feed or the full-width `＝`, `＋`, `－` or `＠` gets a leading single quote, so a spreadsheet does not read it as a formula.
- An archive path: relative, with no empty part, no `..` and no backslash. `writeArchive` refuses any other path, and `readArchive` refuses an archive that holds one.
