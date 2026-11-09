/**
 * The export's fetch list (studio v2 spec 8.4), end to end through the tool: the export route answers the files a
 * film's timeline names that the repository does not hold, and the tool fetches each through the files route with the
 * studio key, checks its sha256, writes it at its path with its `stock.json` beside it, then cuts and validates the
 * whole set, all or nothing. A fetch that fails leaves the repository as it was. Before any of it the tool reads the
 * engine clone and answers `engine_too_old` when the clone predates the shapes the export writes. The studio is a
 * scripted `node:http` server; the engine is a stand-in for its process.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolContext, resolveConfig } from '../src/index.js';
import { DEFAULT_SOURCE_PATHS } from '../src/export.js';
import { toolDefinition } from '../src/tools.js';
import { FAKE_KEY, FILM_ID, engineStub, fixture, sha256Hex, silentLog, startScriptedStudio, type ScriptedAnswer, type ScriptedRequest, type ScriptedStudio } from './helpers.js';

const FILES = '/api/v1/wildweave/studio/files';

/** One staged file of the account, as the export route lists it, with the bytes the files route serves. */
interface Staged {
  path: string;
  bytes: Buffer;
  stockJson: string;
  /** The address the route names; the files route's own by default. */
  url?: string;
  /** The size the route lists; the bytes' own by default. */
  listedBytes?: number;
}

function staged(path: string, content: string): Staged {
  const bytes = Buffer.from(content);
  const id = path.split('/')[3] ?? 'item';
  const stockJson = `${JSON.stringify({ schemaVersion: 1, id: `pexels-${id}`, source: 'pexels', kind: 'video', license: 'Pexels License', files: [{ path, role: 'original', bytes: bytes.byteLength, sha256: sha256Hex(bytes) }] }, null, 2)}\n`;
  return { path, bytes, stockJson };
}

/** The route's fetch entry for a staged file. */
function entryOf(file: Staged): Record<string, unknown> {
  const sha256 = sha256Hex(file.bytes);
  return {
    path: file.path,
    sha256,
    bytes: file.listedBytes ?? file.bytes.byteLength,
    url: file.url ?? `${FILES}/${sha256}?key=${encodeURIComponent(`wildweave-film/account-demo/studio/${sha256}`)}`,
    rights: { licence: 'Pexels License', licenceId: 'pexels-license', licenceUrl: 'https://www.pexels.com/license/', attribution: '', rights: 'licensed', changes: '', notice: '', sourceUrl: 'https://www.pexels.com/video/2041/', provider: 'pexels', sourceId: '2041' },
    stockJson: file.stockJson,
  };
}

const texts = () => fixture<{ texts: Record<string, string> }>('export-sources').texts;
const stockOf = (path: string): string => `${dirname(path)}/stock.json`;

let scratch: string;
let studio: ScriptedStudio;
beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-fetch-'));
  studio = await startScriptedStudio();
});
afterEach(async () => {
  await studio.close();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The studio's answers: the timeline, the export with its fetch list over each source's base (`old`: the repository
 * holds the old texts, so every source is written; `same`: it holds the exported texts already), the acknowledgement,
 * and the files route serving each staged file by its sha256 unless `refuse` names it.
 */
function serve(files: Staged[], opts: { bases: 'old' | 'same'; refuse?: (file: Staged) => ScriptedAnswer | undefined; ack?: ScriptedAnswer }): void {
  studio.answer = (request: ScriptedRequest): ScriptedAnswer => {
    const path = request.path.split('?')[0]!;
    if (request.method === 'GET' && path === `/films/${FILM_ID}/timeline`) return { status: 200, body: fixture('timeline') };
    if (request.method === 'POST' && path === `/films/${FILM_ID}/export`) {
      const ack = (request.body as { ack?: Record<string, string> } | undefined)?.ack;
      if (ack) return opts.ack ?? { status: 200, body: { seq: 9, sources: {}, rebound: false } };
      const sources = Object.fromEntries(
        Object.entries(texts()).map(([name, text]) => {
          const sha256 = sha256Hex(text);
          return [name, { text, sha256, baseSha256: opts.bases === 'old' ? sha256Hex(`old ${name}\n`) : sha256, changed: opts.bases === 'old', notes: [] }];
        }),
      );
      return { status: 200, body: { recordFormat: 2, sources, fetch: files.map(entryOf) } };
    }
    const file = files.find((f) => request.method === 'GET' && path === `/files/${sha256Hex(f.bytes)}`);
    if (file) return opts.refuse?.(file) ?? { status: 200, raw: file.bytes };
    return { status: 404, body: { error: 'not_found' } };
  };
}

/** A film repository holding each source: its old text, or the text the export answers. */
function repo(holds: 'old' | 'same'): string {
  const root = join(scratch, 'film');
  for (const [name, rel] of Object.entries(DEFAULT_SOURCE_PATHS)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), holds === 'old' ? `old ${name}\n` : texts()[name]!);
  }
  return realpathSync(root);
}

/** An engine clone: its package.json at `version`, with the keyframes module the v2 shapes need unless `keyframes` is false. */
function engineClone(version: string, keyframes = true): string {
  const dir = join(scratch, `engine-${version}-${keyframes ? 'k' : 'nok'}`);
  mkdirSync(join(dir, 'src', 'lib', 'wildweave'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'wilds-ai', version, private: true })}\n`);
  if (keyframes) writeFileSync(join(dir, 'src', 'lib', 'wildweave', 'film-keyframes.ts'), 'export {};\n');
  return dir;
}

const PASSES = '{"ok":true,"result":{"ok":true,"findings":[]},"records":[]}\n';
const REFUSES = '{"ok":true,"result":{"ok":false,"findings":[{"level":"error","code":"asset_missing","message":"x"}]},"records":[]}\n';

async function context(root: string, engineDir: string, stub: ReturnType<typeof engineStub>) {
  const config = await resolveConfig({ key: FAKE_KEY, baseUrl: studio.baseUrl, filmRepo: root, engineDir }, undefined, {});
  return createToolContext(config, silentLog, { execFile: stub.execFile });
}

const run = async (root: string, engineDir: string, stub: ReturnType<typeof engineStub>, extra: Record<string, unknown> = {}) =>
  (await toolDefinition('wildweave_film_export').run({ filmId: FILM_ID, writeTo: '.', ...extra }, await context(root, engineDir, stub))) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };

const fileRequests = () => studio.requests.filter((r) => r.path.startsWith('/files/'));
const acks = () => studio.requests.filter((r) => (r.body as { ack?: unknown } | undefined)?.ack !== undefined);
const leftovers = (root: string) => readdirSync(root).filter((name) => name.startsWith('.wildweave-export-'));

describe('the export fetches the studio files its timeline names into the film repository', () => {
  it('writes a fetched file at its path with its stock.json beside it, before the engine cuts and validates the whole set', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'same' });
    const seenAtCut: boolean[] = [];
    const stub = engineStub((call) => {
      if (call.argv[1] === 'cut') seenAtCut.push(existsSync(join(root, clip.path)));
      return { stdout: PASSES };
    });
    const answer = await run(root, engineClone('0.1.0'), stub);
    expect(answer).toMatchObject({ ok: true, result: { validated: true, fetched: [{ path: clip.path, sha256: sha256Hex(clip.bytes), bytes: clip.bytes.byteLength, stock: stockOf(clip.path), forced: false }] } });
    expect(readFileSync(join(root, clip.path))).toEqual(clip.bytes);
    expect(readFileSync(join(root, stockOf(clip.path)), 'utf8')).toBe(clip.stockJson);
    // The engine cut the set with the fetched file already at its path under the assets root.
    expect(seenAtCut).toEqual([true]);
    expect(stub.calls.map((c) => c.argv[1])).toEqual(['cut', 'validate']);
    // The file came through the files route, with the key in Authorization and the route's own key query.
    expect(fileRequests()).toHaveLength(1);
    expect(fileRequests()[0]!.fullPath).toBe(`${FILES}/${sha256Hex(clip.bytes)}`);
    expect(new URLSearchParams(fileRequests()[0]!.path.split('?')[1]).get('key')).toBe(`wildweave-film/account-demo/studio/${sha256Hex(clip.bytes)}`);
    expect(fileRequests()[0]!.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(leftovers(root)).toEqual([]);
  });

  it('rolls back when the second fetch fails: fetch_failed names its path, and nothing is written or acknowledged', async () => {
    const root = repo('old');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    const gull = staged('assets/music/catalog/77/gull.wav', 'gull sting bytes');
    serve([clip, gull], { bases: 'old', refuse: (file) => (file === gull ? { status: 404, body: { error: 'not_found' } } : undefined) });
    const stub = engineStub(() => ({ stdout: PASSES }));
    const answer = await run(root, engineClone('0.1.0'), stub);
    expect(answer).toMatchObject({ ok: false, error: { code: 'fetch_failed', details: { path: gull.path } } });
    expect(answer.error!.message).toContain(gull.path);
    // The first file was fetched, then thrown away with the rest: no file, no record, no source moved.
    expect(fileRequests()).toHaveLength(2);
    expect(existsSync(join(root, clip.path))).toBe(false);
    expect(existsSync(join(root, stockOf(clip.path)))).toBe(false);
    expect(existsSync(join(root, 'assets'))).toBe(false);
    for (const [name, rel] of Object.entries(DEFAULT_SOURCE_PATHS)) expect({ name, text: readFileSync(join(root, rel), 'utf8') }).toEqual({ name, text: `old ${name}\n` });
    expect(stub.calls).toEqual([]);
    expect(acks()).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });

  it('refuses a fetched file whose bytes are not its sha256, and writes nothing', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'same', refuse: () => ({ status: 200, raw: Buffer.from('other bytes') }) });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: false, error: { code: 'fetch_failed', details: { path: clip.path } } });
    expect(existsSync(join(root, 'assets'))).toBe(false);
  });

  it('never fetches a file the repository already holds at its path', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    mkdirSync(join(root, dirname(clip.path)), { recursive: true });
    writeFileSync(join(root, clip.path), clip.bytes);
    serve([clip], { bases: 'same' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: true, result: { fetched: [], fetchUnchanged: [clip.path] } });
    expect(fileRequests()).toEqual([]);
  });

  it('refuses an address outside the files route, and sends the key nowhere else', async () => {
    const root = repo('same');
    const clip = { ...staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes'), url: 'https://elsewhere.example.invalid/files/x?key=wildweave-film%2Faccount-7f3e%2Fx' };
    serve([clip], { bases: 'same' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: false, error: { code: 'fetch_failed', details: { path: clip.path } } });
    // The refusal names the address without its query: the storage key it carries is not repeated to the caller.
    expect(JSON.stringify(answer)).not.toContain('account-7f3e');
    expect(answer.error!.message).toContain('https://elsewhere.example.invalid/files/x');
    expect(fileRequests()).toEqual([]);
    expect(existsSync(join(root, 'assets'))).toBe(false);
  });

  it('refuses a fetch path outside the repository, and writes nothing', async () => {
    const root = repo('same');
    const clip = staged('../outside/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'same' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer.ok).toBe(false);
    expect(['fetch_failed', 'path_outside_repo']).toContain(answer.error!.code);
    expect(existsSync(join(scratch, 'outside'))).toBe(false);
    expect(fileRequests()).toEqual([]);
  });

  it('puts a fetched file back when the engine refuses the set, and leaves no folder it made', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'same' });
    const stub = engineStub((call) =>
      call.argv[1] === 'validate' ? { stdout: '{"ok":true,"result":{"ok":false,"findings":[{"level":"error","code":"asset_missing","message":"x"}]},"records":[]}\n' } : { stdout: PASSES },
    );
    const answer = await run(root, engineClone('0.1.0'), stub);
    expect(answer).toMatchObject({ ok: false, error: { code: 'export_invalid' } });
    expect(existsSync(join(root, clip.path))).toBe(false);
    expect(existsSync(join(root, 'assets'))).toBe(false);
    expect(acks()).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });
});

describe('the fetched files when the repository moves under the export, or the route lists them oddly', () => {
  it('keeps a save made to a fetched file while the engine checks the set, and names it, when the engine then refuses the set', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'same' });
    const stub = engineStub((call) => {
      // An editor saves over the fetched clip while the engine cuts the set.
      if (call.argv[1] === 'cut') writeFileSync(join(root, clip.path), 'his own trim');
      return { stdout: call.argv[1] === 'validate' ? REFUSES : PASSES };
    });
    const answer = await run(root, engineClone('0.1.0'), stub);
    expect(answer).toMatchObject({ ok: false, error: { code: 'export_invalid', details: { kept: [{ fetch: clip.path, path: clip.path, diskSha256: sha256Hex('his own trim') }] } } });
    expect(answer.error!.message).toContain(clip.path);
    // His save stays; the record the export placed, which nobody touched, comes out again.
    expect(readFileSync(join(root, clip.path), 'utf8')).toBe('his own trim');
    expect(existsSync(join(root, stockOf(clip.path)))).toBe(false);
    expect(acks()).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });

  it('reports a fetched file as forced when force wrote over one that appeared at its path while it was fetched', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], {
      bases: 'same',
      refuse: () => {
        mkdirSync(join(root, dirname(clip.path)), { recursive: true });
        writeFileSync(join(root, clip.path), 'saved meanwhile');
        return undefined;
      },
    });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })), { force: true });
    expect(answer).toMatchObject({ ok: true, result: { fetched: [{ path: clip.path, forced: true }] } });
    expect(readFileSync(join(root, clip.path))).toEqual(clip.bytes);
  });

  it('writes the stock.json of a file the repository already holds with its hash when the record is missing, without fetching the file', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    mkdirSync(join(root, dirname(clip.path)), { recursive: true });
    writeFileSync(join(root, clip.path), clip.bytes);
    serve([clip], { bases: 'same' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: true, result: { fetched: [], fetchUnchanged: [clip.path], stockWritten: [{ path: stockOf(clip.path), file: clip.path, forced: false }] } });
    expect(readFileSync(join(root, stockOf(clip.path)), 'utf8')).toBe(clip.stockJson);
    expect(fileRequests()).toEqual([]);
  });

  it('refuses a held file whose stock.json holds another record: source_changed names the record, and nothing is written', async () => {
    const root = repo('old');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    mkdirSync(join(root, dirname(clip.path)), { recursive: true });
    writeFileSync(join(root, clip.path), clip.bytes);
    writeFileSync(join(root, stockOf(clip.path)), '{"edited":"by the librarian"}\n');
    serve([clip], { bases: 'old' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ fetch: stockOf(clip.path), path: stockOf(clip.path), diskSha256: sha256Hex('{"edited":"by the librarian"}\n') }] } } });
    expect(readFileSync(join(root, stockOf(clip.path)), 'utf8')).toBe('{"edited":"by the librarian"}\n');
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.timeline), 'utf8')).toBe('old timeline\n');
    expect(fileRequests()).toEqual([]);
  });

  it('checks the listed size of every entry, a second entry sharing a file's hash included', async () => {
    const root = repo('same');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    const twin = { ...staged('assets/stock/pexels/2042/harbour.mp4', 'harbour clip bytes'), listedBytes: 999 };
    serve([clip, twin], { bases: 'same' });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: false, error: { code: 'fetch_failed', details: { path: twin.path, code: 'size_mismatch' } } });
    expect(fileRequests()).toHaveLength(1);
    expect(existsSync(join(root, 'assets'))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  it('names the fetched files beside the written sources when the acknowledgement is refused', async () => {
    const root = repo('old');
    const clip = staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes');
    serve([clip], { bases: 'old', ack: { status: 409, body: { error: 'stale_write', current: {} } } });
    const answer = await run(root, engineClone('0.1.0'), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'stale_write', details: { fetched: [{ path: clip.path, sha256: sha256Hex(clip.bytes), stock: stockOf(clip.path) }] } },
    });
    expect((answer.error!.details!.written as unknown[]).length).toBe(Object.keys(DEFAULT_SOURCE_PATHS).length);
    expect(answer.error!.message).toContain('fetched');
    expect(readFileSync(join(root, clip.path))).toEqual(clip.bytes);
  });
});

describe('the engine clone the export validates with', () => {
  it('answers engine_too_old from a clone at a lower version, before anything is read or written', async () => {
    const root = repo('old');
    serve([staged('assets/stock/pexels/2041/harbour.mp4', 'harbour clip bytes')], { bases: 'old' });
    const stub = engineStub(() => ({ stdout: PASSES }));
    const answer = await run(root, engineClone('0.0.9'), stub);
    expect(answer).toMatchObject({ ok: false, error: { code: 'engine_too_old', details: { version: '0.0.9', floor: '0.1.0' } } });
    expect(studio.requests).toEqual([]);
    expect(stub.calls).toEqual([]);
    expect(readFileSync(join(root, DEFAULT_SOURCE_PATHS.timeline), 'utf8')).toBe('old timeline\n');
  });

  it('answers engine_too_old from a clone at the version that lacks the engine module the v2 shapes need', async () => {
    const root = repo('old');
    serve([], { bases: 'old' });
    const answer = await run(root, engineClone('0.1.0', false), engineStub(() => ({ stdout: PASSES })));
    expect(answer).toMatchObject({ ok: false, error: { code: 'engine_too_old', details: { version: '0.1.0', missing: 'src/lib/wildweave/film-keyframes.ts' } } });
    expect(studio.requests).toEqual([]);
  });
});
