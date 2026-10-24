/**
 * The image's two projects (image/manifests.mjs): each a package.json and a lockfile cut from the workspace's
 * pnpm-lock.yaml, which the Dockerfile installs with pnpm's frozen install, so the image holds only the packages the
 * lockfile records. A frozen install refuses a lockfile its manifest disagrees with, so the cut has to agree with the
 * manifest it writes beside it, line for line with the workspace's own entries.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPORTER, imageProjects, pnpmRelease } from '../image/manifests.mjs';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** A YAML scalar's value, its quotes taken off. */
function unquote(text: string): string {
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"')) return JSON.parse(text) as string;
  return text;
}

/** A lockfile's top-level block `key`, from its own line to the next top-level key; undefined when it has none. */
function block(lock: string, key: string): string | undefined {
  const lines = lock.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z]\w*:/.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end).join('\n');
}

/** One importer's lines in a lockfile's importers block, from its key line to the blank line that ends it. */
function importer(lock: string, name: string): string[] {
  const lines = lock.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && (lines[end] ?? '').startsWith('    ')) end += 1;
  return lines.slice(start, end);
}

/** The `specifier:` and `version:` lines an importer writes under a dependency, its key quoted or not. */
function entry(lines: string[], name: string): string[] {
  const at = lines.findIndex((line) => line === `      ${name}:` || line === `      '${name}':`);
  return at < 0 ? [] : lines.slice(at + 1, at + 3);
}

/** The pack's importer as pnpm writes it into the workspace's lockfile. */
const PACK_IMPORTER = [
  `  ${IMPORTER}:`,
  '    devDependencies:',
  "      '@framers/agentos':",
  '        specifier: ^0.14.25',
  '        version: 0.14.25(typescript@5.4.5)',
  "      '@types/node':",
  '        specifier: 22.20.1',
  '        version: 22.20.1',
  '      typescript:',
  '        specifier: 5.4.5',
  '        version: 5.4.5',
].join('\n');

/** A workspace lockfile of pnpm's shape around the given text for the pack's importer. */
function workspace(packImporter: string): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'overrides:',
    "  '@framers/agentos': ^0.14.25",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      typescript:',
    '        specifier: ^5.4.5',
    '        version: 5.9.3',
    '',
    packImporter,
    '',
    'packages:',
    '',
    "  '@framers/agentos@0.14.25':",
    '    resolution: {integrity: sha512-AAAA}',
    '',
    'snapshots:',
    '',
    "  '@framers/agentos@0.14.25(typescript@5.4.5)':",
    '    dependencies:',
    '      typescript: 5.4.5',
    '',
  ].join('\n');
}

describe("the image's projects", () => {
  it("cuts the repository's lockfile into two projects whose manifests it is up to date with: one importer each, of the pack's own lines, the workspace's packages and snapshots as they are, and no overrides", () => {
    const lock = read('../../../../../pnpm-lock.yaml');
    const root = JSON.parse(read('../../../../../package.json')) as { packageManager?: string };
    const pack = JSON.parse(read('../package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const projects = imageProjects(root, pack, lock);
    expect(projects.pnpm).toBe(String(root.packageManager).split('+')[0]);
    const compile = projects.compile.manifest.devDependencies as Record<string, string>;
    expect(Object.keys(compile).sort()).toEqual(['@framers/agentos', '@types/node', 'typescript']);
    expect(compile.typescript).toBe(pack.devDependencies.typescript);
    expect(compile['@types/node']).toBe(pack.devDependencies['@types/node']);
    const runtime = projects.runtime.manifest.dependencies as Record<string, string>;
    expect(Object.keys(runtime).sort()).toEqual(['@framers/agentos', ...Object.keys(pack.dependencies ?? {})].sort());

    const packEntries = importer(lock, IMPORTER);
    for (const [project, field] of [[projects.compile, 'devDependencies'], [projects.runtime, 'dependencies']] as const) {
      const cut = project.lockfile as string;
      for (const key of ['lockfileVersion', 'settings', 'packages', 'snapshots']) expect(block(cut, key)).toBe(block(lock, key));
      expect(block(cut, 'overrides')).toBeUndefined();
      const own = importer(cut, '.');
      // Its importers block holds the project's own importer and nothing else, with the one field its manifest names.
      expect(block(cut, 'importers')?.split('\n').filter((line) => /^ {2}\S/.test(line))).toEqual(['  .:']);
      expect(own.filter((line) => /^ {4}\S/.test(line))).toEqual([`    ${field}:`]);
      const manifest = project.manifest[field] as Record<string, string>;
      for (const [name, specifier] of Object.entries(manifest)) {
        const lines = entry(own, name);
        expect(lines).toHaveLength(2);
        expect(lines).toEqual(entry(packEntries, name));
        expect(unquote(lines[0]?.replace(/^ {8}specifier: /, '') ?? '')).toBe(specifier);
      }
      expect(own.filter((line) => /^ {6}\S/.test(line))).toHaveLength(Object.keys(manifest).length);
    }
  });

  it('refuses a linked core, a core below the peer floor, a pin the lockfile is not up to date with, a dependency only the workspace holds, an optional one, a missing importer, a lockfile it cannot cut and a packageManager that names no pnpm release', () => {
    const pnpm = { packageManager: 'pnpm@10.34.7' };
    const pack = {
      peerDependencies: { '@framers/agentos': '>=0.14.20' },
      devDependencies: { '@framers/agentos': 'workspace:^', '@types/node': '22.20.1', typescript: '5.4.5' },
    };
    expect(imageProjects(pnpm, pack, workspace(PACK_IMPORTER)).agentos).toBe('0.14.25');

    const linked = PACK_IMPORTER.replace('version: 0.14.25(typescript@5.4.5)', 'version: link:../../../../packages/agentos');
    expect(() => imageProjects(pnpm, pack, workspace(linked))).toThrow(/not a release on npm/);
    const floor = { ...pack, peerDependencies: { '@framers/agentos': '>=0.15.0' } };
    expect(() => imageProjects(pnpm, floor, workspace(PACK_IMPORTER))).toThrow(/below the pack's peer floor/);
    const moved = { ...pack, devDependencies: { ...pack.devDependencies, typescript: '5.9.3' } };
    expect(() => imageProjects(pnpm, moved, workspace(PACK_IMPORTER))).toThrow(/not up to date/);
    const sibling = [PACK_IMPORTER, '    dependencies:', "      '@framers/agentos-ext-other':", '        specifier: workspace:^', '        version: link:../other'].join('\n');
    const withSibling = { ...pack, dependencies: { '@framers/agentos-ext-other': 'workspace:^' } };
    expect(() => imageProjects(pnpm, withSibling, workspace(sibling))).toThrow(/not a release on npm/);
    const optional = [PACK_IMPORTER, '    optionalDependencies:', '      fsevents:', '        specifier: ^2.3.3', '        version: 2.3.3'].join('\n');
    expect(() => imageProjects(pnpm, pack, workspace(optional))).toThrow(/do not carry/);
    expect(() => imageProjects(pnpm, pack, workspace(''))).toThrow(/has no importer/);
    expect(() => imageProjects(pnpm, pack, workspace(PACK_IMPORTER).replace("'9.0'", "'6.0'"))).toThrow(/version 9/);
    expect(() => imageProjects(pnpm, pack, `---\n${workspace(PACK_IMPORTER)}`)).toThrow(/more than one document/);

    expect(() => imageProjects({ packageManager: 'npm@10.9.0' }, pack, workspace(PACK_IMPORTER))).toThrow(/not a pnpm release/);
    expect(pnpmRelease({ packageManager: 'pnpm@10.34.7+sha512.0123abcd' })).toBe('pnpm@10.34.7');
  });
});
