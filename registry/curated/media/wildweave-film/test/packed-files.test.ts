import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import { TOOL_NAMES } from '../src/schemas.js';
import { FAKE_KEY, bannedWords, engineStub, fixture, startFakeStudio } from './helpers.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, string | Record<string, string>>;
};

/** The files `npm pack` would put in the tarball, as its dry run lists them. */
function packedFiles(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], { cwd: packageDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = JSON.parse(out.slice(out.indexOf('['))) as Array<{ files: Array<{ path: string }> }>;
  return listing[0]!.files.map((f) => f.path).sort();
}

/** The listing, packed once for the file: prepack builds before it lists, so the build is fresh after the first call. */
let listing: string[] | undefined;
const packed = (): string[] => (listing ??= packedFiles());

const ALLOWED = (file: string): boolean =>
  file.startsWith('dist/') || file.startsWith('bin/') || ['manifest.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(file);

/** A path of the package as `package.json` names it, without its leading `./`. */
const bare = (path: string): string => path.replace(/^\.\//, '');

describe('what the tarball holds', () => {
  // The tarball packs the build; CI builds every pack before its tests. Without a build there is nothing to pack.
  it.skipIf(!built)('holds the build, the bin and the package files alone, no source map, and no word of a private film', () => {
    const files = packed();
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
  }, 120_000);

  it.skipIf(!built)('is dist, bin and manifest.json, with the files npm always packs; every export, the bin and its imports inside it', () => {
    const files = packed();
    const top = [...new Set(files.map((file) => file.split('/')[0]!))].sort();
    // npm packs package.json, the README and the licence whatever `files` says; the CHANGELOG may come with them.
    expect(top.filter((entry) => entry !== 'CHANGELOG.md')).toEqual(['LICENSE', 'README.md', 'bin', 'dist', 'manifest.json', 'package.json']);
    expect(files.filter((file) => file.startsWith('bin/'))).toEqual(['bin/wildweave-film-mcp.mjs']);
    // dist is the build alone: JavaScript, its declarations and the tools' JSON Schemas; no test, script or source compiled into it.
    expect(files.filter((file) => file.startsWith('dist/') && !/\.(?:js|d\.ts)$/.test(file) && !/^dist\/schemas\/wildweave_film_[a-z_]+\.json$/.test(file))).toEqual([]);
    expect(files.filter((file) => /^dist\/(?:test|scripts|src)\//.test(file))).toEqual([]);
    const targets = [
      pkg.main,
      pkg.types,
      ...Object.values(pkg.bin),
      ...Object.values(pkg.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target))),
    ].map(bare);
    for (const target of targets) expect(files, target).toContain(target);
    const imports = [...readFileSync(new URL('../bin/wildweave-film-mcp.mjs', import.meta.url), 'utf8').matchAll(/from '\.\.\/(dist\/[^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const target of imports) expect(files, target).toContain(target);
  }, 120_000);

  it.skipIf(!built)("writes each tool's schemas into dist/schemas exactly as the reviewed goldens hold them", () => {
    packed();
    for (const name of TOOL_NAMES) {
      const written = JSON.parse(readFileSync(new URL(`../dist/schemas/${name}.json`, import.meta.url), 'utf8')) as unknown;
      const golden = JSON.parse(readFileSync(new URL(`./goldens/${name}.json`, import.meta.url), 'utf8')) as unknown;
      expect(written, name).toEqual(golden);
    }
  }, 120_000);

  it("lists the pack's 22 tools in manifest.json, by the ids and names the pack gives them, and the one secret", () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      id: string;
      version: string;
      categories: string[];
      extensions: Array<{ kind: string; id: string; displayName: string }>;
      requiredSecrets: string[];
    };
    expect(manifest.id).toBe('com.framers.media.wildweave-film');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.categories).toEqual(['tool', 'media']);
    expect(manifest.extensions).toEqual(TOOL_DEFINITIONS.map((def) => ({ kind: 'tool', id: def.name, displayName: def.displayName })));
    expect(manifest.extensions.map((e) => e.id)).toEqual(TOOL_NAMES);
    expect(manifest.requiredSecrets).toEqual(['wildweave.studio.key']);
  });
});

describe('the built package in a test host', () => {
  // The host imports the build through the package's exports, as it would from node_modules: the pack, its tools, a
  // route call against a fake studio and a run of a stand-in engine; then each code entry's named exports.
  it.skipIf(!built)('loads from dist through the exports map: 22 tools, a studio call and an engine run', async () => {
    packed();
    const entry = (name: string): string => {
      const target = pkg.exports[name]!;
      return new URL(`../${bare(typeof target === 'string' ? target : target.import!)}`, import.meta.url).href;
    };
    const mod = (await import(entry('.'))) as typeof import('../src/index.js');
    expect(mod.default).toBe(mod.createExtensionPack);
    expect(mod.PACKAGE_VERSION).toBe(pkg.version);

    const studio = await startFakeStudio();
    const scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-built-'));
    try {
      const engineDir = join(scratch, 'engine');
      mkdirSync(engineDir);
      const engine = engineStub(() => ({ stdout: '{"ok":true,"result":{"scenes":3},"records":[]}\n' }));
      const pack = await mod.createExtensionPack({
        options: { key: FAKE_KEY, baseUrl: studio.baseUrl, engineDir },
        logDestination: { write: () => undefined },
        deps: { execFile: engine.execFile },
      });
      expect(pack.name).toBe('@framers/agentos-ext-wildweave-film');
      expect(pack.descriptors.map((d) => d.id)).toEqual(TOOL_NAMES);
      const tool = (name: string) => pack.descriptors.find((d) => d.id === name)!.payload;
      expect(await tool('wildweave_film_list').execute({})).toMatchObject({ success: true, output: { ok: true, result: fixture('films') } });
      expect(studio.requests[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(await tool('wildweave_film_coverage').execute({ cut: '/r/cut.json', assets: '/r', out: '/r/render' })).toMatchObject({ success: true, output: { ok: true, result: { scenes: 3 } } });
      expect(engine.calls[0]!.argv).toEqual(['wildweave-film', 'coverage', '--cut=/r/cut.json', '--assets=/r', '--out=/r/render', '--json']);
    } finally {
      await studio.close();
      rmSync(scratch, { recursive: true, force: true });
    }

    const client = (await import(entry('./client'))) as Record<string, unknown>;
    const schemas = (await import(entry('./schemas'))) as Record<string, unknown>;
    const mcp = (await import(entry('./mcp'))) as Record<string, unknown>;
    expect(typeof client.WildweaveStudioClient).toBe('function');
    for (const name of ['toolJsonSchema', 'toolResult']) expect(typeof schemas[name], name).toBe('function');
    for (const name of ['createWildweaveMcpServer', 'createWildweaveMcpHandler', 'serveWildweaveHttp', 'serveWildweaveStdio']) expect(typeof mcp[name], name).toBe('function');
  }, 120_000);
});
