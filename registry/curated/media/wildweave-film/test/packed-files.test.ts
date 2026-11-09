import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, inject, it } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import { TOOL_NAMES } from '../src/schemas.js';
import { FAKE_KEY, bannedWords, engineStub, fixture, packTool, startFakeStudio } from './helpers.js';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, string | Record<string, string>>;
  gitHead?: string;
};

/**
 * The files `npm pack` would put in the tarball, as its dry run lists them. `test/global-setup.ts` packs once before any
 * test file starts, because `prepack` rewrites `dist` and the bin tests start processes that import it.
 */
const packed = (): string[] => inject('packedFiles');

const ALLOWED = (file: string): boolean =>
  file.startsWith('dist/') || file.startsWith('bin/') || ['manifest.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(file);

/** A path of the package as `package.json` names it, without its leading `./`. */
const bare = (path: string): string => path.replace(/^\.\//, '');

/** Below zero when `a` is the lower x.y.z version, zero when they are equal, above zero when `a` is the higher. */
function versionOrder(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => (version.split('-')[0] ?? '').split('.').map(Number));
  for (let i = 0; i < 3; i += 1) {
    const step = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (step !== 0) return step;
  }
  return 0;
}

describe('what the tarball holds', () => {
  // The tarball packs the build; the pack's test script builds it first, so a missing build fails here.
  it('holds the build, the bin and the package files alone, no source map, and no word of a private film', () => {
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

  it('is dist, bin and manifest.json, with the files npm always packs; every export, the bin and its imports inside it', () => {
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

  it("writes each tool's schemas into dist/schemas exactly as the reviewed goldens hold them", () => {
    packed();
    for (const name of TOOL_NAMES) {
      const written = JSON.parse(readFileSync(new URL(`../dist/schemas/${name}.json`, import.meta.url), 'utf8')) as unknown;
      const golden = JSON.parse(readFileSync(new URL(`./goldens/${name}.json`, import.meta.url), 'utf8')) as unknown;
      expect(written, name).toEqual(golden);
    }
  }, 120_000);

  it("lists the pack's 23 tools in manifest.json, by the ids and names the pack gives them, and the one secret", () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      id: string;
      version: string;
      categories: string[];
      extensions: Array<{ kind: string; id: string; displayName: string }>;
      requiredSecrets: string[];
    };
    expect(manifest.id).toBe('com.framers.media.wildweave-film');
    // On a run that releases the pack, the release plan writes the commit as package.json's gitHead and raises
    // manifest.json to the planned version, so the two match in the tarball it publishes. On any other run it writes the
    // newest published version into package.json alone, so the committed manifest may lag it, never pass it.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (pkg.gitHead !== undefined) expect(manifest.version).toBe(pkg.version);
    else expect(versionOrder(manifest.version, pkg.version)).toBeLessThanOrEqual(0);
    expect(manifest.categories).toEqual(['tool', 'media']);
    expect(manifest.extensions).toEqual(TOOL_DEFINITIONS.map((def) => ({ kind: 'tool', id: def.name, displayName: def.displayName })));
    expect(manifest.extensions.map((e) => e.id)).toEqual(TOOL_NAMES);
    expect(manifest.requiredSecrets).toEqual(['wildweave.studio.key']);
  });
});

/**
 * Each of the package's exports as a consumer's Node resolves it: a separate Node process inside the package resolves
 * the package's own name and each subpath through the exports map (a package may import itself by name), and imports
 * each code entry there. Answers each subpath's file URL and, for a code entry, its export names.
 */
function throughExports(): Record<string, { url: string; names?: string[] }> {
  const specs = Object.keys(pkg.exports).map((sub) => (sub === '.' ? pkg.name : `${pkg.name}${sub.slice(1)}`));
  const script = [
    'const out = {};',
    'for (const spec of JSON.parse(process.env.WILDWEAVE_SPECS)) {',
    '  const url = import.meta.resolve(spec);',
    "  out[spec] = url.endsWith('.json') ? { url } : { url, names: Object.keys(await import(spec)).sort() };",
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', WILDWEAVE_SPECS: JSON.stringify(specs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bySpec = JSON.parse(out) as Record<string, { url: string; names?: string[] }>;
  return Object.fromEntries(Object.keys(pkg.exports).map((sub, i) => [sub, bySpec[specs[i]!]!]));
}

describe('the built package in a test host', () => {
  // The host imports the build through the package's exports, as it would from node_modules: the pack, its tools, a
  // route call against a fake studio and a run of a stand-in engine; then each code entry's named exports.
  it('loads from dist through the exports map: 23 tools, a studio call and an engine run', async () => {
    packed();
    // Every entry as Node resolves the package's name for a consumer, each to the file its exports row names.
    const resolved = throughExports();
    for (const [sub, target] of Object.entries(pkg.exports)) {
      const file = new URL(`../${bare(typeof target === 'string' ? target : target.import!)}`, import.meta.url).href;
      expect(resolved[sub]!.url, sub).toBe(file);
    }
    expect(resolved['.']!.names).toEqual(expect.arrayContaining(['PACKAGE_VERSION', 'createExtensionPack', 'default']));
    const entry = (name: string): string => resolved[name]!.url;
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
      const tool = (name: string) => packTool(pack, name);
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
    expect(resolved['./client']!.names).toContain('WildweaveStudioClient');
    expect(resolved['./schemas']!.names).toEqual(expect.arrayContaining(['toolJsonSchema', 'toolResult']));
    expect(resolved['./mcp']!.names).toEqual(expect.arrayContaining(['createWildweaveMcpServer', 'createWildweaveMcpHandler', 'serveWildweaveHttp', 'serveWildweaveStdio']));
    for (const name of ['toolJsonSchema', 'toolResult']) expect(typeof schemas[name], name).toBe('function');
    for (const name of ['createWildweaveMcpServer', 'createWildweaveMcpHandler', 'serveWildweaveHttp', 'serveWildweaveStdio']) expect(typeof mcp[name], name).toBe('function');
  }, 120_000);
});
