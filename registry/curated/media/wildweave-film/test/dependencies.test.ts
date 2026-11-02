import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bannedWords } from './helpers.js';

const packageDir = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', packageDir), 'utf8')) as Record<string, Record<string, string> | undefined>;

/** Every file under a folder. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const at = join(dir, name);
    return statSync(at).isDirectory() ? filesUnder(at) : [at];
  });
}

describe('what the package depends on and holds', () => {
  it('depends on no database driver or adapter', () => {
    const named = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(pkg[field] ?? {}));
    for (const driver of ['pg', 'better-sqlite3', '@framers/sql-storage-adapter', 'postgres', 'mysql2', 'sqlite3']) expect(named).not.toContain(driver);
  });

  it("reads no database and names no film's import keys in its source", () => {
    const files = filesUnder(fileURLToPath(new URL('src', packageDir)));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('WILDS_DATABASE_URL');
      expect(text, file).not.toContain('getFoundationDb');
      expect(bannedWords(text), file).toEqual([]);
    }
  });
});
