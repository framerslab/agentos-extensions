/**
 * The calendar entry as a browser bundle meets it: `./calendar` resolved by the package's name through its exports
 * map to the build CI makes before the tests run, and every module that build reaches read for its imports. A bundler
 * follows the same static and dynamic imports, so a graph with no Node built-in among them bundles for a browser with
 * no Node shims. The source graph is read too, so a type-only import of a Node module is caught before it is erased.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '../..');
const packageJson = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, { import: string; types: string } | string | undefined>;
};

/** Static imports and re-exports, side-effect imports, dynamic imports and `require` calls, by their specifier. */
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** The files reached from `entry` by relative imports, and every specifier that is not relative. */
function graph(entry: string, source: boolean): { files: string[]; outside: string[] } {
  const files: string[] = [];
  const outside: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    // comments go first, so an example in a doc comment is not read as an import; `://` in an address is kept
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    for (const pattern of SPECIFIERS) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) {
          outside.push(specifier);
          continue;
        }
        const target = resolve(dirname(file), source ? specifier.replace(/\.js$/, '.ts') : specifier);
        expect(existsSync(target), `${file} imports ${specifier}`).toBe(true);
        queue.push(target);
      }
    }
  }
  return { files, outside };
}

/** Whether `specifier` names a module Node provides. */
function builtIn(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]!);
}

describe('the calendar entry, as a browser bundle resolves it', () => {
  it('resolves by the package name to the build its exports map names, and declares both helpers', async () => {
    const calendar = packageJson.exports['./calendar'];
    if (calendar === undefined || typeof calendar === 'string') throw new Error('package.json exports no ./calendar entry');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(here, '..', 'consumer', 'resolve-entry.mjs'), `${packageJson.name}/calendar`],
      { cwd: packRoot, timeout: 30_000 },
    );
    const [resolved] = stdout.trim().split('\n').map((line) => JSON.parse(line) as { url: string; names: string[] });
    expect(realpathSync(fileURLToPath(resolved!.url))).toBe(realpathSync(join(packRoot, calendar.import)));
    expect(resolved!.names).toEqual(expect.arrayContaining(['googleCalendarAddress', 'icsEvent']));
    const declared = readFileSync(join(packRoot, calendar.types), 'utf8');
    expect(declared).toContain('icsEvent');
    expect(declared).toContain('googleCalendarAddress');
  }, 30_000);

  it('reaches no Node built-in, and no package at all, from the build or the source', () => {
    const calendar = packageJson.exports['./calendar'];
    if (calendar === undefined || typeof calendar === 'string') throw new Error('package.json exports no ./calendar entry');
    const built = graph(join(packRoot, calendar.import), false);
    expect(built.files.map((file) => file.slice(packRoot.length + 1))).toEqual(
      expect.arrayContaining(['dist/calendar/index.js', 'dist/calendar/ics.js', 'dist/calendar/google.js']),
    );
    expect(built.outside.filter(builtIn)).toEqual([]);
    expect(built.outside).toEqual([]);

    const source = graph(join(packRoot, 'src/calendar/index.ts'), true);
    expect(source.files.length).toBeGreaterThanOrEqual(3);
    expect(source.outside).toEqual([]);
  });

  it('exports the helpers from the package root, and markdownText from the browser-safe transcript entry too', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(here, '..', 'consumer', 'resolve-entry.mjs'), packageJson.name, `${packageJson.name}/transcript`],
      { cwd: packRoot, timeout: 30_000 },
    );
    const [root, transcript] = stdout.trim().split('\n').map((line) => JSON.parse(line) as { names: string[] });
    expect(root!.names).toEqual(expect.arrayContaining(['googleCalendarAddress', 'icsEvent', 'markdownText']));
    expect(transcript!.names).toEqual(expect.arrayContaining(['markdownText']));
  }, 30_000);
});
