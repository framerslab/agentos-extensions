import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../daemon-main.js';

const dirs: string[] = [];
const tdir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What Node puts in import.meta.url for an entry script: its real path as a file URL. */
const moduleUrlOf = (file: string) => pathToFileURL(realpathSync(file)).href;

describe('isEntryPoint', () => {
  it('matches an entry path that a file URL percent-encodes (a space in a directory name)', () => {
    const dir = tdir('attach entry ');
    const file = join(dir, 'daemon-main.js');
    writeFileSync(file, '');
    const moduleUrl = moduleUrlOf(file);
    expect(moduleUrl).toContain('%20');
    expect(isEntryPoint(moduleUrl, file)).toBe(true);
    // The comparison this replaces never matched such a path.
    expect(moduleUrl === `file://${file}`).toBe(false);
  });

  it('matches an entry launched through a symlink, resolved by Node or kept by --preserve-symlinks-main', () => {
    const dir = tdir('attach-entry-');
    const real = join(dir, 'real.js');
    const link = join(dir, 'link.js');
    writeFileSync(real, '');
    symlinkSync(real, link);
    // Default: Node resolved the link before building import.meta.url.
    expect(isEntryPoint(moduleUrlOf(real), link)).toBe(true);
    // --preserve-symlinks-main: import.meta.url still names the link.
    expect(isEntryPoint(pathToFileURL(link).href, link)).toBe(true);
    expect(isEntryPoint(pathToFileURL(link).href, real)).toBe(true);
  });

  it('is false for another module, a missing entry path, no entry path and a non-file module URL', () => {
    const dir = tdir('attach-entry-');
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    writeFileSync(a, '');
    writeFileSync(b, '');
    expect(isEntryPoint(moduleUrlOf(a), b)).toBe(false);
    expect(isEntryPoint(moduleUrlOf(a), join(dir, 'missing.js'))).toBe(false);
    expect(isEntryPoint(moduleUrlOf(a), undefined)).toBe(false);
    expect(isEntryPoint('data:text/javascript,', a)).toBe(false);
  });
});
