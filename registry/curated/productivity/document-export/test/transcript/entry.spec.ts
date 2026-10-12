import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toMarkdown } from '../../src/transcript/text.js';
import { SAMPLE } from './sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, '../../src/transcript');
const packRoot = resolve(here, '../..');

/** What the entry exports, typed from its source. */
type TranscriptEntry = typeof import('../../src/transcript/index.js');

/** Every function the entry publishes. */
const FUNCTIONS = [
  'actionItemsCsv',
  'clock',
  'csvField',
  'cueText',
  'cueTime',
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
  it('imports nothing but its own files and fflate', () => {
    const outside: string[] = [];
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), 'utf8');
      for (const match of source.matchAll(/(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('./') && match[1] !== 'fflate') outside.push(`${file}: ${match[1]}`);
      }
    }
    expect(outside).toEqual([]);
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
