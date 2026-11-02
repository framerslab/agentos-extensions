import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/schemas.js';
import { bannedWords } from './helpers.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));

/** The files `npm pack` would put in the tarball, as its dry run lists them. */
function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = JSON.parse(out.slice(out.indexOf('['))) as Array<{ files: Array<{ path: string }> }>;
  return listing[0]!.files.map((f) => f.path).sort();
}

const ALLOWED = (file: string): boolean =>
  file.startsWith('dist/') || file.startsWith('bin/') || ['manifest.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(file);

describe('what the tarball holds', () => {
  // The tarball packs the build; CI builds every pack before its tests. Without a build there is nothing to pack.
  it.skipIf(!built)('holds the build, the bin and the package files alone, no source map, and no word of a private film', () => {
    const files = packedFiles();
    expect(files.filter((file) => !ALLOWED(file))).toEqual([]);
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    expect(files).toContain('dist/index.js');
    expect(files).toContain('dist/mcp/index.js');
    expect(files).toContain('bin/wildweave-film-mcp.mjs');
    // prepack writes each tool's JSON Schemas beside the build, for a host that reads them without importing the package.
    for (const name of TOOL_NAMES) expect(files).toContain(`dist/schemas/${name}.json`);
    for (const file of files) {
      expect(bannedWords(readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8')), file).toEqual([]);
    }
  });
});
