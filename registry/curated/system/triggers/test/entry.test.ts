/**
 * The root entry exports, at run time, the names `scripts/package-roles.json` lists for this
 * package. The pack guard imports each listed name from the tarball only for a package a run
 * publishes, so this case holds the entry and the list together on every run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';

const PACKAGE_DIR = 'registry/curated/system/triggers';

interface PackageRoles {
  readonly roles: Readonly<Record<string, string>>;
  readonly libraryExports: Readonly<Record<string, readonly string[]>>;
}

describe('the root entry', () => {
  it('is a library whose run-time exports are exactly the names the package roles list, each a function', () => {
    const roles = JSON.parse(readFileSync(new URL('../../../../../scripts/package-roles.json', import.meta.url), 'utf8')) as PackageRoles;
    expect(roles.roles[PACKAGE_DIR]).toBe('library');
    const listed = [...(roles.libraryExports[PACKAGE_DIR] ?? [])].sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(Object.keys(entry).sort()).toEqual(listed);
    for (const name of listed) {
      expect({ name, type: typeof (entry as Readonly<Record<string, unknown>>)[name] }).toEqual({ name, type: 'function' });
    }
  });
});
