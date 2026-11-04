import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The fields of a package.json this walk reads. */
interface Manifest {
  name: string;
  version: string;
  license?: unknown;
  licenses?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(folder: string): Manifest {
  return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as Manifest;
}

/** The folder `name` resolves to from `from`, by Node's walk up the node_modules folders, or null. */
function locate(from: string, name: string): string | null {
  for (let folder = from; ; folder = dirname(folder)) {
    const candidate = join(folder, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(folder) === folder) return null;
  }
}

/**
 * Whether a package grants anything: a `license` field, the older `licenses` list, or a licence
 * file in the package, as png-js ships. A package with none of the three gives no grant to ship it,
 * and `UNLICENSED` in the field says the same in words, so it counts as no field.
 */
function statesLicence(folder: string, manifest: Manifest): boolean {
  const { license, licenses } = manifest;
  const named = typeof license === 'object' && license !== null && 'type' in license ? license.type : license;
  if (typeof named === 'string' && named.trim() !== '' && named.trim().toUpperCase() !== 'UNLICENSED') return true;
  if (Array.isArray(licenses) && licenses.length > 0) return true;
  return readdirSync(folder).some((file) => /^(licen[cs]e|copying)(\.|$)/i.test(file));
}

/** Every package the pack's production dependencies install, as installed from the lockfile. */
function walkProductionTree(root: string): {
  packages: Map<string, string>;
  unresolved: string[];
} {
  const packages = new Map<string, string>();
  const unresolved: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const folder = pending.pop() as string;
    if (visited.has(folder)) continue;
    visited.add(folder);
    const manifest = readManifest(folder);
    if (folder !== root) packages.set(`${manifest.name}@${manifest.version}`, folder);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const found = locate(folder, name);
      if (found === null) unresolved.push(`${manifest.name}@${manifest.version} > ${name}`);
      else pending.push(found);
    }
    // An optional dependency for another platform is not installed, so its absence says nothing.
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const found = locate(folder, name);
      if (found !== null) pending.push(found);
    }
  }
  return { packages, unresolved };
}

describe('the licences of the production dependency tree', () => {
  const { packages, unresolved } = walkProductionTree(realpathSync(packRoot));

  it('reaches every production dependency', () => {
    expect(unresolved).toEqual([]);
    const names = [...packages.keys()].map((id) => id.slice(0, id.lastIndexOf('@')));
    for (const direct of Object.keys(readManifest(packRoot).dependencies ?? {})) {
      expect(names).toContain(direct);
    }
  });

  it('holds no package without a stated licence', () => {
    const unstated = [...packages]
      .filter(([, folder]) => !statesLicence(folder, readManifest(folder)))
      .map(([id]) => id)
      .sort();
    expect(unstated).toEqual([]);
  });
});

describe('what counts as a stated licence', () => {
  const emptyFolder = (): string => mkdtempSync(join(tmpdir(), 'licences-'));
  const manifest = (fields: Partial<Manifest>): Manifest => ({ name: 'fixture', version: '1.0.0', ...fields });

  it('refuses a package that says UNLICENSED, which grants nothing', () => {
    expect(statesLicence(emptyFolder(), manifest({ license: 'UNLICENSED' }))).toBe(false);
    expect(statesLicence(emptyFolder(), manifest({ license: { type: 'UNLICENSED' } }))).toBe(false);
  });

  it('refuses a package with no field and no licence file', () => {
    expect(statesLicence(emptyFolder(), manifest({}))).toBe(false);
  });

  it('takes a licence named in a field or a licence file', () => {
    expect(statesLicence(emptyFolder(), manifest({ license: 'MIT' }))).toBe(true);
    expect(statesLicence(emptyFolder(), manifest({ license: { type: 'MIT' } }))).toBe(true);
    expect(statesLicence(emptyFolder(), manifest({ licenses: [{ type: 'MIT' }] }))).toBe(true);
    const folder = emptyFolder();
    writeFileSync(join(folder, 'LICENSE'), 'MIT');
    expect(statesLicence(folder, manifest({}))).toBe(true);
  });
});
