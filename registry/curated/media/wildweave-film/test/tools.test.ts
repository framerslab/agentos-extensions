import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolContext, resolveConfig } from '../src/index.js';
import { engineArgv, runEngine } from '../src/local.js';
import { TOOL_DEFINITIONS, toolDefinition, type ToolContext } from '../src/tools.js';
import { DEFAULT_SOURCE_PATHS } from '../src/export.js';
import {
  FAKE_KEY,
  FILM_ID,
  SAMPLE_ARGS,
  engineStub,
  fixture,
  sha256Hex,
  silentLog,
  startFakeStudio,
  startScriptedStudio,
  type FakeStudio,
  type ScriptedStudio,
} from './helpers.js';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-test-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A context whose engine is the stand-in, in an engine folder that exists. */
async function localContext(stub: ReturnType<typeof engineStub>, extra: { key?: string; filmRepo?: string; baseUrl?: string } = {}) {
  const engineDir = join(scratch, 'engine');
  mkdirSync(engineDir, { recursive: true });
  const config = await resolveConfig({ engineDir, ...(extra.key ? { key: extra.key } : {}), ...(extra.filmRepo ? { filmRepo: extra.filmRepo } : {}), baseUrl: extra.baseUrl ?? 'https://studio.example.invalid' }, undefined, {});
  return createToolContext(config, silentLog, { execFile: stub.execFile });
}

describe('the engine runner', () => {
  it('builds the argument array: --flag=value, a true as --flag, a list joined by commas, --json last', () => {
    expect(engineArgv('cut', { timeline: '/r/production/timeline.json', sidecar: '/r/production/render.json', assets: '/r', normDir: '/r/norm', out: '/r/production/cut.json', draft: true, strict: false })).toEqual({
      ok: true,
      argv: ['wildweave-film', 'cut', '--timeline=/r/production/timeline.json', '--sidecar=/r/production/render.json', '--assets=/r', '--norm-dir=/r/norm', '--out=/r/production/cut.json', '--draft', '--json'],
    });
    expect(engineArgv('preview', { scenes: ['s01', 's02'], beds: true })).toEqual({ ok: true, argv: ['wildweave-film', 'preview', '--scenes=s01,s02', '--beds', '--json'] });
  });

  it('refuses a value that begins with "-", a list item with a comma, and a value of another type', () => {
    expect(engineArgv('strip', { scene: '-rf' })).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
    expect(engineArgv('preview', { scenes: ['s01', '--all'] })).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
    expect(engineArgv('preview', { scenes: ['s01,s02'] })).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
    expect(engineArgv('render', { jobs: { many: true } as unknown as string })).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
  });

  it('answers engine_missing without an engine folder, or with one that does not exist', async () => {
    expect(await runEngine({}, 'cut', {})).toMatchObject({ ok: false, error: { code: 'engine_missing' } });
    expect(await runEngine({ engineDir: join(scratch, 'nowhere') }, 'cut', {})).toMatchObject({ ok: false, error: { code: 'engine_missing' } });
  });

  it("runs pnpm in the engine folder and passes the command's last-line object through", async () => {
    const stub = engineStub(() => ({ stdout: '> wilds-ai wildweave-film\n{"ok":true,"result":{"scenes":3},"records":["/r/reports/validate.json"]}\n' }));
    const ctx = await localContext(stub);
    const answer = await toolDefinition('wildweave_film_validate').run({ cut: '/r/production/cut.json', assets: '/r', strict: true }, ctx);
    expect(answer).toEqual({ ok: true, result: { scenes: 3 }, records: ['/r/reports/validate.json'] });
    expect(stub.calls[0]!.file).toBe('pnpm');
    expect(stub.calls[0]!.cwd).toBe(join(scratch, 'engine'));
    expect(stub.calls[0]!.argv).toEqual(['wildweave-film', 'validate', '--cut=/r/production/cut.json', '--assets=/r', '--strict', '--json']);
  });

  it("passes the command's refusal through, and reads no JSON as engine_failed with the stderr tail", async () => {
    const refusal = engineStub(() => ({ stdout: '{"ok":false,"error":{"code":"cut_refused","message":"the sidecar is refused","sceneId":"s02"}}\n', exitCode: 1 }));
    expect(await toolDefinition('wildweave_film_coverage').run({ cut: '/r/cut.json', assets: '/r', out: '/r/render' }, await localContext(refusal))).toEqual({
      ok: false,
      error: { code: 'cut_refused', message: 'the sidecar is refused', sceneId: 's02' },
    });
    const crash = engineStub(() => ({ stdout: '', stderr: `boom with ${FAKE_KEY}\n`, exitCode: 2 }));
    const answer = await toolDefinition('wildweave_film_coverage').run({ cut: '/r/cut.json', assets: '/r', out: '/r/render' }, await localContext(crash));
    expect(answer).toMatchObject({ ok: false, error: { code: 'engine_failed', details: { exitCode: 2 } } });
    expect(JSON.stringify(answer)).not.toContain(FAKE_KEY);
  });

  it('renders with jobs auto by default and the plan it is asked for', async () => {
    const stub = engineStub();
    const ctx = await localContext(stub);
    await toolDefinition('wildweave_film_render').run({ cut: '/r/production/cut.json', assets: '/r', out: '/r/render', kind: 'draft', by: 'scene', requireStrips: true }, ctx);
    expect(stub.calls[0]!.argv).toEqual(['wildweave-film', 'render', '--cut=/r/production/cut.json', '--assets=/r', '--out=/r/render', '--draft', '--jobs=auto', '--by=scene', '--require-strips', '--json']);
    expect(await toolDefinition('wildweave_film_render').run({ cut: '/r/cut.json', assets: '/r', out: '/r/render', kind: 'audio' }, ctx)).toMatchObject({ ok: false, error: { code: 'kind_not_local' } });
  });

  it("refuses a scene id that begins with '-' before anything runs", async () => {
    const stub = engineStub();
    const answer = await toolDefinition('wildweave_film_strip').run({ cut: '/r/cut.json', assets: '/r', out: '/r/render', scene: '-x' }, await localContext(stub));
    expect(answer).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
    expect(stub.calls).toHaveLength(0);
  });

  it('gives an import the key in the child environment alone, never in its arguments', async () => {
    const before = process.env.WILDWEAVE_STUDIO_KEY;
    process.env.WILDWEAVE_STUDIO_KEY = FAKE_KEY;
    try {
      const stub = engineStub();
      const ctx = await localContext(stub, { key: FAKE_KEY });
      await toolDefinition('wildweave_film_import').run({ film: '/r', out: '/r/out', target: 'production' }, ctx);
      const call = stub.calls[0]!;
      expect(call.argv).toEqual(['wildweave-film', 'import', '--film=/r', '--out=/r/out', '--target=production', '--base-url=https://studio.example.invalid', '--json']);
      expect(call.argv.join(' ')).not.toContain(FAKE_KEY);
      expect(call.env.WILDS_IMPORT_TOKEN).toBe(FAKE_KEY);
      expect(call.env.WILDWEAVE_STUDIO_KEY).toBeUndefined();

      await toolDefinition('wildweave_film_cut').run({ timeline: '/r/production/timeline.json', assets: '/r', out: '/r/production/cut.json' }, ctx);
      expect(stub.calls[1]!.env.WILDS_IMPORT_TOKEN).toBeUndefined();
      expect(stub.calls[1]!.env.WILDWEAVE_STUDIO_KEY).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.WILDWEAVE_STUDIO_KEY;
      else process.env.WILDWEAVE_STUDIO_KEY = before;
    }
  });

  it('plans a dry-run import without the key', async () => {
    const stub = engineStub();
    await toolDefinition('wildweave_film_import').run({ film: '/r', out: '/r/out', target: 'dry-run' }, await localContext(stub));
    expect(stub.calls[0]!.argv).toEqual(['wildweave-film', 'import', '--film=/r', '--out=/r/out', '--dry-run', '--base-url=https://studio.example.invalid', '--json']);
    expect(stub.calls[0]!.env.WILDS_IMPORT_TOKEN).toBeUndefined();
  });

  it('resolves a relative path against the film repository, as the defaults are, not the working directory', async () => {
    const stub = engineStub();
    const filmRepo = join(scratch, 'film');
    mkdirSync(filmRepo, { recursive: true });
    await toolDefinition('wildweave_film_cut').run({ assets: '.', out: 'production/cut.json' }, await localContext(stub, { filmRepo }));
    expect(stub.calls[0]!.argv).toEqual([
      'wildweave-film',
      'cut',
      `--timeline=${join(filmRepo, 'production', 'timeline.json')}`,
      `--sidecar=${join(filmRepo, 'production', 'render.json')}`,
      `--assets=${filmRepo}`,
      `--out=${join(filmRepo, 'production', 'cut.json')}`,
      '--json',
    ]);
  });

  it('pushes the preview with the key in the environment and the scenes as one list', async () => {
    const stub = engineStub();
    await toolDefinition('wildweave_film_preview_push').run({ film: '/r', out: '/r/render', scenes: ['s01', 's03'], beds: true }, await localContext(stub, { key: FAKE_KEY }));
    expect(stub.calls[0]!.argv).toEqual(['wildweave-film', 'preview', '--film=/r', '--out=/r/render', '--target=production', '--scenes=s01,s03', '--beds', '--base-url=https://studio.example.invalid', '--json']);
    expect(stub.calls[0]!.env.WILDS_IMPORT_TOKEN).toBe(FAKE_KEY);
  });
});

describe('the export written into the film repository', () => {
  let studio: FakeStudio;
  beforeEach(async () => {
    studio = await startFakeStudio();
  });
  afterEach(async () => {
    await studio.close();
  });

  const texts = () => fixture<{ texts: Record<string, string> }>('export-sources').texts;

  /** A film repository holding the sources as the last crossing left them. */
  function repo(): string {
    const root = join(scratch, 'film');
    for (const [name, rel] of Object.entries(DEFAULT_SOURCE_PATHS)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), `old ${name}\n`);
    }
    return root;
  }

  async function exportContext(filmRepo: string) {
    const config = await resolveConfig({ key: FAKE_KEY, baseUrl: studio.baseUrl, filmRepo }, undefined, {});
    return createToolContext(config, silentLog);
  }

  it('writes every changed source, then acknowledges the written hashes', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.' }, await exportContext(root));
    expect(answer).toMatchObject({ ok: true, result: { validated: false, ack: { seq: 5, rebound: true } } });
    for (const [name, rel] of Object.entries(DEFAULT_SOURCE_PATHS)) expect(readFileSync(join(root, rel), 'utf8')).toBe(texts()[name]);
    const ack = studio.requests.find((r) => r.method === 'POST' && (r.body as { ack?: unknown })?.ack);
    expect((ack!.body as { ack: Record<string, string> }).ack.timeline).toBe(sha256Hex(texts().timeline!));
    expect((ack!.body as { ifUpdatedAtMs: Record<string, number> }).ifUpdatedAtMs).toEqual(fixture<{ updatedAtMs: unknown }>('timeline').updatedAtMs);
    expect(readdirSync(root).filter((n) => n.startsWith('.wildweave-export-'))).toEqual([]);
    // The texts are on disk; the answer leaves them out.
    const sources = (answer as unknown as { result: { sources: Record<string, Record<string, unknown>> } }).result.sources;
    expect(Object.keys(sources).sort()).toEqual(['beatSheet', 'script', 'sidecar', 'takes', 'timeline']);
    expect(sources.script).not.toHaveProperty('text');
  });

  it('refuses a source the repository changed since the last crossing, and writes nothing', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    writeFileSync(join(root, DEFAULT_SOURCE_PATHS.sidecar), 'edited in the repository\n');
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.' }, await exportContext(root));
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar', diskSha256: sha256Hex('edited in the repository\n') }] } } });
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.timeline), 'utf8')).toBe('old timeline\n');
    expect(studio.requests.some((r) => (r.body as { ack?: unknown } | undefined)?.ack)).toBe(false);
  });

  it('writes over it with force, and says so', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    writeFileSync(join(root, DEFAULT_SOURCE_PATHS.sidecar), 'edited in the repository\n');
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', force: true }, await exportContext(root));
    expect(answer.ok).toBe(true);
    const written = (answer as unknown as { result: { written: Array<{ source: string; forced: boolean }> } }).result.written;
    expect(written.find((w) => w.source === 'sidecar')).toMatchObject({ forced: true });
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.sidecar), 'utf8')).toBe(texts().sidecar);
  });

  it('refuses a destination outside the repository, and a source path a symlink carries out of it', async () => {
    const root = repo();
    const ctx = await exportContext(root);
    expect(await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '../elsewhere' }, ctx)).toMatchObject({ ok: false, error: { code: 'path_outside_repo' } });
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    rmSync(join(root, 'production'), { recursive: true });
    symlinkSync(outside, join(root, 'production'));
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = null;
    expect(await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', force: true }, ctx)).toMatchObject({ ok: false, error: { code: 'path_outside_repo' } });
    expect(existsSync(join(outside, 'timeline.json'))).toBe(false);
  });

  it('makes a writeTo folder the repository lacks, and writes the sources into it', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = null;
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: 'drafts/next' }, await exportContext(root));
    expect(answer).toMatchObject({ ok: true, result: { ack: { rebound: true } } });
    for (const [name, rel] of Object.entries(DEFAULT_SOURCE_PATHS)) expect(readFileSync(join(root, 'drafts/next', rel), 'utf8')).toBe(texts()[name]);
    expect(readdirSync(join(root, 'drafts/next')).filter((n) => n.startsWith('.wildweave-export-'))).toEqual([]);
  });

  it('leaves no folder it made when the engine refuses the exported set', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = null;
    const stub = engineStub(() => ({ stdout: '{"ok":false,"error":{"code":"cut_refused","message":"the timeline names no scene"}}\n', exitCode: 1 }));
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: 'drafts/next' }, await localContext(stub, { key: FAKE_KEY, filmRepo: root, baseUrl: studio.baseUrl }));
    expect(answer).toMatchObject({ ok: false, error: { code: 'export_invalid' } });
    expect(existsSync(join(root, 'drafts'))).toBe(false);
    expect(studio.requests.some((r) => (r.body as { ack?: unknown } | undefined)?.ack)).toBe(false);
  });

  it('refuses a path outside the repository for a source the route leaves out, before the engine reads it', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    studio.omitSources.push('takes');
    writeFileSync(join(scratch, 'outside.md'), 'not the repository\n');
    const stub = engineStub();
    const answer = await toolDefinition('wildweave_film_export').run(
      { filmId: FILM_ID, writeTo: '.', paths: { takes: '../outside.md' } },
      await localContext(stub, { key: FAKE_KEY, filmRepo: root, baseUrl: studio.baseUrl }),
    );
    expect(answer).toMatchObject({ ok: false, error: { code: 'arg_invalid', details: { source: 'takes' } } });
    expect(stub.calls).toEqual([]);
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.timeline), 'utf8')).toBe('old timeline\n');
  });

  it('refuses a source the repository changed while the engine checked the set, keeps the change and puts back what it wrote', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    const sidecar = join(root, DEFAULT_SOURCE_PATHS.sidecar);
    const stub = engineStub((call) => {
      // An editor saves the sidecar while the engine validates the staged set.
      if (call.argv[1] === 'validate') writeFileSync(sidecar, 'edited during the check\n');
      return { stdout: '{"ok":true,"result":{"ok":true,"findings":[]},"records":[]}\n' };
    });
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.' }, await localContext(stub, { key: FAKE_KEY, filmRepo: root, baseUrl: studio.baseUrl }));
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar', diskSha256: sha256Hex('edited during the check\n') }] } } });
    expect(readFileSync(sidecar, 'utf8')).toBe('edited during the check\n');
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.timeline), 'utf8')).toBe('old timeline\n');
    expect(studio.requests.some((r) => (r.body as { ack?: unknown } | undefined)?.ack)).toBe(false);
    expect(readdirSync(root).filter((n) => n.startsWith('.wildweave-export-'))).toEqual([]);
  });

  it('writes over a source changed while the engine checked the set when force is given, and says so', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = sha256Hex(`old ${name}\n`);
    const sidecar = join(root, DEFAULT_SOURCE_PATHS.sidecar);
    const stub = engineStub((call) => {
      if (call.argv[1] === 'validate') writeFileSync(sidecar, 'edited during the check\n');
      return { stdout: '{"ok":true,"result":{"ok":true,"findings":[]},"records":[]}\n' };
    });
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', force: true }, await localContext(stub, { key: FAKE_KEY, filmRepo: root, baseUrl: studio.baseUrl }));
    expect(answer.ok).toBe(true);
    const written = (answer as unknown as { result: { written: Array<{ source: string; forced: boolean }> } }).result.written;
    expect(written.find((w) => w.source === 'sidecar')).toMatchObject({ forced: true });
    expect(written.find((w) => w.source === 'timeline')).toMatchObject({ forced: false });
    expect(readFileSync(sidecar, 'utf8')).toBe(texts().sidecar);
  });

  it('keeps a file written into a folder it made while the set was checked, when the export is refused', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = null;
    const next = join(root, 'drafts', 'next');
    const stub = engineStub((call) => {
      // While the engine validates, an editor saves the sidecar and a note into the folder the export just made.
      if (call.argv[1] === 'validate') {
        mkdirSync(join(next, 'production'), { recursive: true });
        writeFileSync(join(next, DEFAULT_SOURCE_PATHS.sidecar), 'saved by an editor\n');
        writeFileSync(join(next, 'notes.md'), 'a note\n');
      }
      return { stdout: '{"ok":true,"result":{"ok":true,"findings":[]},"records":[]}\n' };
    });
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: 'drafts/next' }, await localContext(stub, { key: FAKE_KEY, filmRepo: root, baseUrl: studio.baseUrl }));
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar' }] } } });
    expect(readFileSync(join(next, DEFAULT_SOURCE_PATHS.sidecar), 'utf8')).toBe('saved by an editor\n');
    expect(readFileSync(join(next, 'notes.md'), 'utf8')).toBe('a note\n');
    expect(existsSync(join(next, DEFAULT_SOURCE_PATHS.timeline))).toBe(false);
    expect(existsSync(join(next, 'docs'))).toBe(false);
    expect(readdirSync(next).filter((n) => n.startsWith('.wildweave-export-'))).toEqual([]);
  });

  it('refuses two sources that resolve to one file, a symlink alias included, before anything is written', async () => {
    const root = repo();
    for (const name of Object.keys(DEFAULT_SOURCE_PATHS)) studio.base[name] = null;
    const ctx = await exportContext(root);
    const same = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', force: true, paths: { beatSheet: DEFAULT_SOURCE_PATHS.script } }, ctx);
    expect(same).toMatchObject({ ok: false, error: { code: 'arg_invalid', details: { source: 'beatSheet', path: DEFAULT_SOURCE_PATHS.script } } });
    symlinkSync(join(root, DEFAULT_SOURCE_PATHS.script), join(root, 'docs', 'alias.md'));
    const alias = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', force: true, paths: { beatSheet: 'docs/alias.md' } }, ctx);
    expect(alias).toMatchObject({ ok: false, error: { code: 'arg_invalid', details: { source: 'beatSheet', path: 'docs/alias.md' } } });
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.script), 'utf8')).toBe('old script\n');
    expect(studio.requests.some((r) => (r.body as { ack?: unknown } | undefined)?.ack)).toBe(false);
  });

  it('answers film_repo_missing for a write with no film repository', async () => {
    const config = await resolveConfig({ key: FAKE_KEY, baseUrl: studio.baseUrl }, undefined, {});
    expect(await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.' }, createToolContext(config, silentLog))).toMatchObject({ ok: false, error: { code: 'film_repo_missing' } });
  });

  it('returns the texts without writeTo, and writes nothing', async () => {
    const answer = await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID }, await exportContext(repo()));
    expect(answer).toMatchObject({ ok: true, result: { recordFormat: 2, sources: { script: { text: texts().script } } } });
  });
});

/** The registry as GET /templates answers it, and a film's own table as GET /films/:id/templates answers it: synthetic. */
const REGISTRY = {
  definitions: [
    { id: 'title.serif', kind: 'title', name: 'Serif title', editable: ['type', 'colours', 'timing', 'content'], defaults: { lines: ['Title'] }, params: { type: 'object' }, thumbnailAtMs: 1200 },
    { id: 'credits.roll', kind: 'credits', name: 'Roll', editable: ['colours', 'timing', 'content'], defaults: { linesPerSecond: 1 }, params: { type: 'object' }, thumbnailAtMs: 2000 },
  ],
  transitions: ['cut', 'crossfade', 'dip-to-black', 'wipe', 'dip-to-white'],
  saved: [{ templateId: 'my-title', base: 'title.serif', params: { lines: ['Ours'] }, name: 'Our title', createdAtMs: 1761955300000, updatedAtMs: 1761955300000 }],
};
const FILM_TEMPLATES = { templates: { 'my-credits': { base: 'credits.roll', params: { linesPerSecond: 1 }, name: 'Our credits' } } };

describe('the templates and the refusal envelope, through the tools over the studio', () => {
  let scripted: ScriptedStudio;
  const waits: number[] = [];
  beforeEach(async () => {
    scripted = await startScriptedStudio();
    waits.length = 0;
  });
  afterEach(async () => {
    await scripted.close();
  });

  async function remoteContext(): Promise<ToolContext> {
    const config = await resolveConfig({ key: FAKE_KEY, baseUrl: scripted.baseUrl }, undefined, {});
    return createToolContext(config, silentLog, { sleep: async (ms) => void waits.push(ms) });
  }

  const templatesTool = () => TOOL_DEFINITIONS.find((def) => def.name === ('wildweave_film_templates' as string));

  it("reads the registry's definitions, the transition kinds the box draws and the saved templates", async () => {
    scripted.answer = (request) => (request.method === 'GET' && request.path === '/templates' ? { status: 200, body: REGISTRY } : { status: 404, body: { error: 'not_found' } });
    const tool = templatesTool();
    expect(tool).toBeDefined();
    const answer = await tool!.run({}, await remoteContext());
    expect(answer).toMatchObject({ ok: true, result: REGISTRY });
    expect(scripted.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /templates']);
    expect(scripted.requests[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("with filmId, adds the film's own templates table beside the registry", async () => {
    scripted.answer = (request) => {
      if (request.method === 'GET' && request.path === '/templates') return { status: 200, body: REGISTRY };
      if (request.method === 'GET' && request.path === `/films/${FILM_ID}/templates`) return { status: 200, body: FILM_TEMPLATES };
      return { status: 404, body: { error: 'not_found' } };
    };
    const tool = templatesTool();
    expect(tool).toBeDefined();
    const answer = await tool!.run({ filmId: FILM_ID }, await remoteContext());
    expect(answer).toMatchObject({ ok: true, result: { ...REGISTRY, film: { filmId: FILM_ID, ...FILM_TEMPLATES } } });
    expect(scripted.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /films/film-demo-0001/templates', 'GET /templates']);
  });

  /** The gate's one envelope (the Amendment's A.7), as a route answers it for each code a plan or a room decides. */
  const ENVELOPE_CODES: Array<[string, number]> = [
    ['plan_required', 403],
    ['limit_reached', 402],
    ['budget_exhausted', 402],
    ['not_open', 503],
    ['file_too_large', 413],
  ];
  const envelope = (code: string) => ({
    error: code,
    capability: 'edit.keyframes',
    tier: 'plus',
    requiredPlan: code === 'plan_required' ? 'pro' : null,
    upgradeUrl: '/pricing',
    ...(code === 'limit_reached' ? { limit: { meter: 'films', used: 3, max: 3, window: 'account' } } : {}),
    checkoutPaused: false,
    policyVersion: 2,
    message: `The words for ${code}, as the policy module writes them.`,
  });

  it.each(ENVELOPE_CODES)('%s (HTTP %i) reaches the agent with the envelope\'s message and its fields, sent once, on a read and on a write', async (code, status) => {
    const body = envelope(code);
    scripted.answer = () => ({ status, body });
    const ctx = await remoteContext();
    for (const name of ['wildweave_film_timeline', 'wildweave_film_edit'] as const) {
      scripted.requests.length = 0;
      const answer = await toolDefinition(name).run(SAMPLE_ARGS[name], ctx);
      const { error: _code, message, ...fields } = body;
      expect(answer, name).toMatchObject({ ok: false, error: { code, status, message, refusal: fields } });
      expect(scripted.requests, name).toHaveLength(1);
    }
    expect(waits).toEqual([]);
  });

  it("reads a v1 { error: 'forge_required' } body as before: its code, the client's words, and no envelope", async () => {
    scripted.answer = () => ({ status: 403, body: { error: 'forge_required' } });
    const answer = await toolDefinition('wildweave_film_list').run({}, await remoteContext());
    expect(answer).toMatchObject({ ok: false, error: { code: 'forge_required', status: 403 } });
    expect((answer as { error: { message: string } }).error.message).toMatch(/Forge/);
    expect((answer as unknown as { error: Record<string, unknown> }).error.refusal).toBeUndefined();
    expect(scripted.requests).toHaveLength(1);
  });

  it('waits out rate_limited by its Retry-After, then answers', async () => {
    scripted.answer = () =>
      scripted.requests.length === 1 ? { status: 429, body: { ...envelope('rate_limited'), requiredPlan: null }, headers: { 'retry-after': '2' } } : { status: 200, body: fixture('timeline') };
    const answer = await toolDefinition('wildweave_film_timeline').run({ filmId: FILM_ID }, await remoteContext());
    expect(answer.ok).toBe(true);
    expect(scripted.requests).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });
});
