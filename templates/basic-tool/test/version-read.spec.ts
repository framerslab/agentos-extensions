/**
 * @fileoverview The version the built template pack reports to its host: its own package.json's in place, and none,
 * with a warning through the host's logger, once a bundle moves its code away from that file. A bundle that copies the
 * built files moves '../package.json' to the host's package.json or to no file at all. A pack copied from this
 * template keeps the same read, so the template holds the same guard as the packs. CI builds every package before it
 * runs the tests, so `dist` holds this commit's build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packRoot = fileURLToPath(new URL('..', import.meta.url));
const own = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as { name: string; version: string };
/** The name the template's pack reports, which is not its package's name. */
const packName = '@framers/agentos-ext-template';
/** What the factory is given besides the logger: enough for it to build the pack without a network call. */
const context = { options: {} };

// Inside the package's node_modules, so a moved copy resolves the package's dependencies as an installed bundle does.
mkdirSync(join(packRoot, 'node_modules'), { recursive: true });
const scratch = mkdtempSync(join(packRoot, 'node_modules', '.version-read-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Report {
  name: string;
  version?: string;
  warnings: string[];
}

/** Imports the built entry at `entry` in a fresh Node process; builds the pack with a logger keeping its warnings. */
function report(entry: string): Report {
  const script = `
    const loaded = await import(${JSON.stringify(pathToFileURL(entry).href)});
    const createExtensionPack = loaded.createExtensionPack ?? loaded.default?.createExtensionPack;
    const warnings = [];
    const logger = { info() {}, debug() {}, error() {}, warn: (message) => warnings.push(String(message)) };
    const pack = createExtensionPack({ ...${JSON.stringify(context)}, logger });
    console.log(JSON.stringify({ name: pack.name, version: pack.version, warnings }));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Report;
}

/** Copies `dist` to `<host>/out`, where a bundle's output sits, under `hostManifest` as the host's package.json. */
function moved(host: string, hostManifest?: Record<string, unknown>): string {
  const out = join(scratch, host, 'out');
  cpSync(join(packRoot, 'dist'), out, { recursive: true });
  // Gives the copied files the module type they were built for, as the host's build does; it names no package.
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  if (hostManifest) writeFileSync(join(scratch, host, 'package.json'), JSON.stringify(hostManifest));
  return join(out, 'index.js');
}

describe('the version the built template pack reports', () => {
  it("in place: its own package.json's, with no warning", () => {
    expect(report(join(packRoot, 'dist', 'index.js'))).toEqual({ name: packName, version: own.version, warnings: [] });
  }, 60_000);

  it("moved under a host's package.json: no version, never the host's, and one warning", () => {
    const pack = report(moved('host', { name: 'a-host-app', version: '9.9.9' }));

    expect(pack.name).toBe(packName);
    expect(pack.version).toBeUndefined();
    expect(pack.warnings).toHaveLength(1);
    expect(pack.warnings[0]).toContain(own.name);
  }, 60_000);

  it('moved where no package.json sits above it: building the pack does not throw, no version, and one warning', () => {
    const pack = report(moved('bare'));

    expect(pack.name).toBe(packName);
    expect(pack.version).toBeUndefined();
    expect(pack.warnings).toHaveLength(1);
    expect(pack.warnings[0]).toContain(own.name);
  }, 60_000);
});
