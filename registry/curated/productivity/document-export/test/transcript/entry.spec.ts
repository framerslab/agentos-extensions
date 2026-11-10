import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toMarkdown } from '../../src/transcript/text.js';
import { SAMPLE } from './sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, '../../src/transcript');
const packRoot = resolve(here, '../..');

/** The one module outside its folder the entry may import: the archive's refusal, for a stopped write. */
const ARCHIVE_ERRORS = '../archive/errors.js';

/** The Markdown body text helper, which the entry re-exports and which imports nothing either. */
const MARKDOWN_TEXT = '../text/markdown.js';

/** The modules a source file imports or re-exports values from; a type-only import is left out. */
function valueImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/** What the entry exports, typed from its source. */
type TranscriptEntry = typeof import('../../src/transcript/index.js');

/** Every function the entry publishes. */
const FUNCTIONS = [
  'actionItemsCsv',
  'clock',
  'csvField',
  'cueText',
  'cueTime',
  'markdownText',
  'readArchive',
  'toDocx',
  'toHtml',
  'toJson',
  'toMarkdown',
  'toPlainText',
  'toSrt',
  'toVtt',
  'vttText',
  'writeArchive',
  'xmlText',
];

describe('the transcript entry', () => {
  it("imports nothing but its own files, fflate, the archive's refusal and the Markdown text helper, which import nothing", () => {
    const outside: string[] = [];
    for (const file of readdirSync(folder)) {
      for (const from of valueImports(join(folder, file))) {
        if (!from.startsWith('./') && from !== 'fflate' && from !== ARCHIVE_ERRORS && from !== MARKDOWN_TEXT) {
          outside.push(`${file}: ${from}`);
        }
      }
    }
    expect(outside).toEqual([]);
    // A stopped write throws the archive entry's own ArchiveError; that module stays free of imports, so the entry
    // reaches nothing more through it.
    expect(valueImports(resolve(folder, ARCHIVE_ERRORS.replace(/\.js$/, '.ts')))).toEqual([]);
    expect(valueImports(resolve(folder, MARKDOWN_TEXT.replace(/\.js$/, '.ts')))).toEqual([]);
  });

  it('is published as the build the exports map names, with every function, and writes a zip through fflate', async () => {
    // The file `import '@framers/agentos-ext-document-export/transcript'` loads. The build writes it: CI builds every
    // pack before it runs the tests, as a contributor runs `pnpm run build` before `pnpm test`.
    const packageJson = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string; types: string } | undefined>;
    };
    const target = packageJson.exports['./transcript'];
    if (!target) throw new Error('package.json exports no ./transcript entry');
    expect(existsSync(join(packRoot, target.types)), target.types).toBe(true);
    const entry: TranscriptEntry & Record<string, unknown> = await import(pathToFileURL(join(packRoot, target.import)).href);
    expect(FUNCTIONS.filter((name) => typeof entry[name] !== 'function')).toEqual([]);
    const files = entry.readArchive(
      entry.writeArchive([
        { path: 'budget-review.md', data: entry.toMarkdown(SAMPLE) },
        { path: 'budget-review.docx', data: entry.toDocx(SAMPLE) },
      ]),
    );
    expect(files.map((file) => file.path)).toEqual(['budget-review.md', 'budget-review.docx']);
    // The built entry writes what the source writes, which the other specs pin.
    expect(new TextDecoder().decode(files[0].data)).toBe(toMarkdown(SAMPLE));
  });
});
