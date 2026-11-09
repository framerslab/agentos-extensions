/**
 * @module @framers/agentos-ext-wildweave-film/export
 *
 * The export's write into the film repository: all or nothing, and never over a change the
 * repository made since the last crossing. The one exception is a rollback the file system refuses,
 * which the answer names (`details.unrestored`, `details.notRemoved`) instead of claiming it done.
 *
 * 1. With an engine configured, the engine clone is read first: a clone that predates the shapes the
 *    export writes (its `package.json` version below `ENGINE_FLOOR.version`, or without the engine
 *    module those shapes need, `ENGINE_FLOOR.file`) answers `engine_too_old` with the floor, before
 *    anything is read from the studio or written.
 * 2. The timeline is read for the edit times the acknowledgement is guarded by, then the export
 *    route answers each source's text, sha256 and `baseSha256` (the file's hash as the repository
 *    last held it), and `fetch`: the studio files the timeline names that the repository does not
 *    hold yet (studio v2 spec 8.4).
 * 3. Each source's file is resolved under `writeTo` (the repository root, or a folder inside it,
 *    made when the repository lacks it), symlinks included, and must lie inside
 *    `WILDWEAVE_FILM_REPO`; `force` never lifts this. Every source's path is checked, the ones the
 *    route leaves out too, since the engine's cut reads them, and no two sources may resolve to one
 *    file (`arg_invalid`). Each fetched file's path, and its `stock.json` beside it, is resolved the
 *    same way under `writeTo`, the root the engine's cut reads assets from; a path the route gives
 *    that is not repository-relative answers `fetch_failed`, one that resolves outside the
 *    repository `path_outside_repo`.
 * 4. A file already holding the export is left alone; a file whose hash is the base (or a file
 *    absent while the record holds no base) is written; any other is the repository moving since,
 *    reported `source_changed` with both hashes, and nothing is written unless `force`. A fetched
 *    file the repository holds with its sha256 is never fetched (`fetchUnchanged`), and its
 *    `stock.json`, when the repository lacks it, is written all the same (`stockWritten`); one absent
 *    is fetched; one holding other bytes, or a `stock.json` holding another record (beside a held
 *    file too), is a `source_changed` conflict as a source's is.
 * 5. The set is written into a folder inside the destination. Each fetched file comes through the
 *    files route with the studio key (`GET /files/:sha256?key=`) into that folder and is checked by
 *    its sha256 and its size (every entry's listed size, one sharing another's hash included); a
 *    fetch that fails answers `fetch_failed` naming the path, with nothing moved. The fetched files and their records are then moved into place, so the engine's
 *    cut reads them under the assets root, and the set is cut and validated by the engine when an
 *    engine directory is configured (an error refuses the set, `export_invalid`, and puts the
 *    fetched files back); then the sources are renamed into place. Each file is read again right
 *    before its rename: one that changed since step 4 (an editor saved it while the engine checked
 *    the set) refuses the set, `source_changed`, unless `force` (it is then written over and
 *    reported forced, a fetched file in `fetched` as a source in `written`; a backup is then written again from the new bytes and the file read once
 *    more, and a file still changing after four tries is refused). Each file's folder and backup
 *    are made before that last read, so only the hash stands between the read and the rename; a
 *    save landing in that instant is still written over, since no file-system call renames only
 *    over an unchanged file. A failure part way renames the backups back over the files it
 *    replaced, writing nothing, and removes the ones it made where the repository held none; it
 *    names any it could not put back with where its old bytes are kept (`details.unrestored`; the
 *    staging folder then stays) and any it could not remove (`details.notRemoved`). A file that no
 *    longer holds the export's bytes when the rollback reaches it (an editor saved over a fetched
 *    file while the engine checked the set) is his save: it is kept as it is and named
 *    (`details.kept`), never removed or put back over. Of the folders it made it removes only the
 *    ones left empty.
 * 6. The written sources' hashes are acknowledged to the route, so the next export compares against
 *    them. The acknowledgement names sources alone (the route takes no other name); the fetched
 *    files are named in the answer's `fetched`, and the next import's record lists them. A refused
 *    acknowledgement names what stays written: `written`, `fetched` and `stockWritten`.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { StudioAnswer, StudioError, WildweaveStudioClient } from './client.js';
import type { EngineAnswer, EngineArgs } from './local.js';
import { EXPORT_SOURCE_NAMES } from './schemas.js';

/** A source the export writes back. */
export type ExportSourceName = (typeof EXPORT_SOURCE_NAMES)[number];

/** Where the film repository keeps each source: the layout the engine's import reads. */
export const DEFAULT_SOURCE_PATHS: Readonly<Record<ExportSourceName, string>> = {
  script: 'docs/script/script-v1.md',
  beatSheet: 'docs/story/beat-sheet-v0.md',
  takes: 'docs/script/narration-takes-v1.md',
  timeline: 'production/timeline.json',
  sidecar: 'production/render.json',
};

/**
 * The oldest engine clone that reads the shapes the export writes: template layers, overlays, layer ids, bed runs,
 * marks with E2's fields and keyframes (studio v2 spec 8.3). wilds.ai's `package.json` names `version` 0.1.0 and has not
 * moved it as the engine grew, so the clone must also hold the engine's keyframes module, the last of those shapes to
 * land (the engine of 7 November 2026).
 */
export const ENGINE_FLOOR = Object.freeze({
  version: '0.1.0',
  file: 'src/lib/wildweave/film-keyframes.ts',
  since: 'the engine of 7 November 2026',
});

/** What the export write needs. */
export interface ExportWriteInput {
  filmId: string;
  writeTo?: string;
  force?: boolean;
  paths?: Partial<Record<ExportSourceName, string>>;
}

/** What the export write uses besides its input. */
export interface ExportWriteDeps {
  client: WildweaveStudioClient;
  /** The film repository, the root every written path must lie inside. */
  filmRepo?: string;
  /** Runs the engine; absent when no engine directory is configured. */
  engine?: (subcommand: string, args: EngineArgs) => Promise<EngineAnswer>;
  /** The engine clone the engine runs in, read for its floor (`ENGINE_FLOOR`) before anything else. */
  engineDir?: string;
}

/** The export's answer. */
export type ExportAnswer = { ok: true; result: Record<string, unknown>; requestId?: string } | { ok: false; error: StudioError };

interface RouteSource {
  text: string;
  sha256: string;
  baseSha256: string | null;
  changed: boolean;
  notes: unknown[];
}

/** One file the route's `fetch` lists, as the write reads it. */
interface FetchEntry {
  path: string;
  sha256: string;
  bytes: number | null;
  url: string;
  stockJson: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;

/** True when `p` is `root` or lies inside it. */
function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** A repository-relative path: forward slashes, no `.` or `..` segment, not absolute. */
function isRepositoryPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\u0000')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The real path of `p`: its nearest existing ancestor resolved with its symlinks, the rest appended. */
async function realOf(p: string): Promise<string> {
  const missing: string[] = [];
  let at = p;
  for (;;) {
    try {
      const real = await realpath(at);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return p;
      missing.push(at.slice(parent.length).replace(/^[\\/]+/, ''));
      at = parent;
    }
  }
}

/** The sha256 of the file at `p`, or null when there is none. */
async function fileSha(p: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(p));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The bytes of the file at `p`, or null when there is none. */
async function fileBytes(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Removes the empty folders under `dir`, then `dir` when it is left empty; never a file, never through a symlink. */
async function pruneEmpty(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) if (entry.isDirectory()) await pruneEmpty(join(dir, entry.name));
  await rmdir(dir).catch(() => undefined);
}

/** Below zero when `a` is the lower x.y.z version, zero when they are equal, above zero when `a` is the higher. */
function versionOrder(a: string, b: string): number {
  const [x, y] = [a, b].map((version) => (version.split(/[-+]/)[0] ?? '').split('.').map(Number));
  for (let i = 0; i < 3; i += 1) {
    const step = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (step !== 0) return step;
  }
  return 0;
}

/**
 * Why the engine clone predates the shapes the export writes, or null when it does not or cannot be told: a clone
 * whose `package.json` is missing or names no version is left to the engine to answer for itself.
 */
export async function engineTooOld(engineDir: string): Promise<{ version: string; missing?: string } | null> {
  let version: unknown;
  try {
    version = (JSON.parse(await readFile(join(engineDir, 'package.json'), 'utf8')) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) return null;
  if (versionOrder(version, ENGINE_FLOOR.version) < 0) return { version };
  const held = await stat(join(engineDir, ENGINE_FLOOR.file))
    .then((s) => s.isFile())
    .catch(() => false);
  return held ? null : { version, missing: ENGINE_FLOOR.file };
}

/** How many times a forced export writes a file's backup before it gives up on a file that keeps changing. */
const BACKUP_TRIES = 4;

/** A file the repository changed between the plan and its rename. */
class SourceMovedError extends Error {
  readonly conflict: Record<string, unknown>;

  constructor(conflict: Record<string, unknown>) {
    super(`the repository changed ${String(conflict.source ?? conflict.fetch)} while the export was checked`);
    this.name = 'SourceMovedError';
    this.conflict = conflict;
  }
}

/** A fetch of a listed file that failed: the files route refused it, or its bytes are not its sha256. */
class FetchFailedError extends Error {
  readonly path: string;
  /** What the answer adds beside the path: the route's code and status, or the hash or size the bytes had. */
  readonly info: Record<string, unknown>;

  constructor(path: string, reason: string, info: Record<string, unknown> = {}) {
    super(reason);
    this.name = 'FetchFailedError';
    this.path = path;
    this.info = info;
  }
}

/** The engine refused the set: its message and the details the answer carries. */
class ExportInvalidError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ExportInvalidError';
    this.details = details;
  }
}

const refuse = (code: string, message: string, details?: Record<string, unknown>): ExportAnswer => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

/** The sources the route answered, by name, in the route's order. */
function routeSources(result: unknown): Partial<Record<ExportSourceName, RouteSource>> {
  const sources = isRec(result) && isRec(result.sources) ? result.sources : {};
  const out: Partial<Record<ExportSourceName, RouteSource>> = {};
  for (const name of EXPORT_SOURCE_NAMES) {
    const s = sources[name];
    if (isRec(s) && typeof s.text === 'string' && typeof s.sha256 === 'string') {
      out[name] = {
        text: s.text,
        sha256: s.sha256,
        baseSha256: typeof s.baseSha256 === 'string' ? s.baseSha256 : null,
        changed: s.changed === true,
        notes: Array.isArray(s.notes) ? s.notes : [],
      };
    }
  }
  return out;
}

/** The files the route's `fetch` lists, each read in the shape the write needs, or the first entry that is not. */
function routeFetch(result: unknown): { ok: true; entries: FetchEntry[] } | { ok: false; path: string | null; reason: string } {
  const listed = isRec(result) ? result.fetch : undefined;
  if (listed === undefined) return { ok: true, entries: [] };
  if (!Array.isArray(listed)) return { ok: false, path: null, reason: "the route's fetch is not a list" };
  const entries: FetchEntry[] = [];
  for (const raw of listed) {
    const path = isRec(raw) && typeof raw.path === 'string' ? raw.path : null;
    if (!isRec(raw) || path === null || typeof raw.sha256 !== 'string' || !HEX64.test(raw.sha256) || typeof raw.url !== 'string' || typeof raw.stockJson !== 'string') {
      return { ok: false, path, reason: 'an entry of the fetch list has no path, sha256, files-route address or stock.json' };
    }
    const bytes = typeof raw.bytes === 'number' && Number.isInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : null;
    entries.push({ path, sha256: raw.sha256, bytes, url: raw.url, stockJson: raw.stockJson });
  }
  return { ok: true, entries };
}

/** One file the write moves into the repository: a source, a fetched file, or a fetched file's `stock.json`. */
interface Landing {
  /** What the answer names it by: a source's name, or a fetched path. */
  label: { source: ExportSourceName } | { fetch: string };
  rel: string;
  target: string;
  /** Where its bytes wait in the staging folder. */
  staged: string;
  /** The file's sha256 as the plan read it, or null when there was none. */
  disk: string | null;
  sha256: string;
  /** A source's base, named in its conflict; a fetched file has none. */
  baseSha256?: string | null;
  forced: boolean;
}

/** The export, and its write into the repository when `writeTo` is given. */
export async function exportFilm(input: ExportWriteInput, deps: ExportWriteDeps): Promise<ExportAnswer> {
  if (input.writeTo === undefined) {
    const exported = await deps.client.exportSources(input.filmId);
    return exported.ok ? { ok: true, result: exported.result as Record<string, unknown>, requestId: exported.requestId } : exported;
  }
  if (!deps.filmRepo) return refuse('film_repo_missing', 'no film repository: set WILDWEAVE_FILM_REPO (or options.filmRepo); a write lies inside it');
  let root: string;
  try {
    root = await realpath(deps.filmRepo);
  } catch {
    return refuse('film_repo_missing', `the film repository ${deps.filmRepo} is not a folder on this machine`);
  }
  const dest = await realOf(resolve(root, input.writeTo));
  if (!inside(root, dest)) return refuse('path_outside_repo', 'writeTo lies outside the film repository', { writeTo: input.writeTo });
  // Every source's path, before anything is read or written: the route may leave a source out, and the engine's cut still reads its file.
  const targets = {} as Record<ExportSourceName, { rel: string; target: string }>;
  // Two sources on one file (the same path, or a symlink to another's) would share a staged file and a backup.
  const owners = new Map<string, ExportSourceName>();
  for (const name of EXPORT_SOURCE_NAMES) {
    const rel = input.paths?.[name] ?? DEFAULT_SOURCE_PATHS[name];
    if (!isRepositoryPath(rel)) return refuse('arg_invalid', `the path of ${name} is not relative to the repository with forward slashes and no . or .. segment`, { source: name, path: rel });
    const target = await realOf(resolve(dest, rel));
    if (!inside(root, target)) return refuse('path_outside_repo', `the path of ${name} resolves outside the film repository`, { source: name, path: rel });
    const owner = owners.get(target);
    if (owner !== undefined) return refuse('arg_invalid', `the paths of ${owner} and ${name} resolve to one file; each source needs its own`, { source: name, path: rel, sameAs: owner });
    owners.set(target, name);
    targets[name] = { rel, target };
  }

  // The engine clone before anything is read or written: one that predates the shapes would refuse them in its own words.
  if (deps.engine && deps.engineDir) {
    const old = await engineTooOld(deps.engineDir);
    if (old) {
      return refuse(
        'engine_too_old',
        `the engine clone at ${deps.engineDir} is ${old.version}${old.missing ? ` without ${old.missing}` : ''}: the shapes this export writes need ${ENGINE_FLOOR.version} with ${ENGINE_FLOOR.file}, ${ENGINE_FLOOR.since} or later; pull the clone's master and install it`,
        { version: old.version, floor: ENGINE_FLOOR.version, floorFile: ENGINE_FLOOR.file, since: ENGINE_FLOOR.since, ...(old.missing ? { missing: old.missing } : {}) },
      );
    }
  }

  // The edit times first: an edit landing between this read and the export makes the acknowledgement stale, never wrong.
  const timeline: StudioAnswer = await deps.client.timeline(input.filmId);
  if (!timeline.ok) return timeline;
  const updatedAtMs = isRec(timeline.result) && isRec(timeline.result.updatedAtMs) ? (timeline.result.updatedAtMs as Record<string, number>) : {};
  const exported = await deps.client.exportSources(input.filmId);
  if (!exported.ok) return exported;
  const sources = routeSources(exported.result);
  const recordFormat = isRec(exported.result) ? exported.result.recordFormat : undefined;
  const listed = routeFetch(exported.result);
  if (!listed.ok) return refuse('fetch_failed', `${listed.reason}; nothing was written`, { path: listed.path });

  interface Plan {
    name: ExportSourceName;
    rel: string;
    target: string;
    source: RouteSource;
    disk: string | null;
    action: 'write' | 'same';
    forced: boolean;
  }
  const plans: Plan[] = [];
  const conflicts: Array<Record<string, unknown>> = [];
  for (const name of EXPORT_SOURCE_NAMES) {
    const source = sources[name];
    if (!source) continue;
    const { rel, target } = targets[name];
    const info = await lstat(target).catch(() => null);
    if (info && !info.isFile()) return refuse('path_outside_repo', `the path of ${name} is not a regular file`, { source: name, path: rel });
    const disk = await fileSha(target);
    if (disk === source.sha256) {
      plans.push({ name, rel, target, source, disk, action: 'same', forced: false });
    } else if (disk === source.baseSha256) {
      plans.push({ name, rel, target, source, disk, action: 'write', forced: false });
    } else if (input.force) {
      plans.push({ name, rel, target, source, disk, action: 'write', forced: true });
    } else {
      conflicts.push({ source: name, path: rel, diskSha256: disk, baseSha256: source.baseSha256, sha256: source.sha256 });
    }
  }

  // The fetch list: each file's path and its stock.json under writeTo, never on a source's file or on one another.
  interface StockPlan {
    rel: string;
    target: string;
    disk: string | null;
    sha256: string;
    forced: boolean;
  }
  interface FetchPlan {
    entry: FetchEntry;
    file: { rel: string; target: string; disk: string | null; forced: boolean };
    stock: StockPlan | null;
    /** The file's landing and its record's, once staged: what `land` found there decides `forced`. */
    landings: Landing[];
  }
  const fetchPlans: FetchPlan[] = [];
  const fetchUnchanged: string[] = [];
  // The records written beside files the repository already holds with their hashes: a missing stock.json is the
  // rights line those files lack, so it is written though the file is never fetched again.
  const heldStocks: Array<{ entry: FetchEntry; file: string; stock: StockPlan; landing?: Landing }> = [];
  const fetchOwners = new Map<string, string>();
  const stockTexts = new Map<string, string>();
  for (const entry of listed.entries) {
    const rel = entry.path;
    if (!isRepositoryPath(rel)) return refuse('fetch_failed', `the fetch list names ${JSON.stringify(rel)}, which is not relative to the repository with forward slashes and no . or .. segment; nothing was written`, { path: rel });
    const stockRel = posix.join(posix.dirname(rel), 'stock.json');
    if (stockRel === rel) return refuse('fetch_failed', `the fetch list names ${rel}, the path of its own stock.json; nothing was written`, { path: rel });
    const target = await realOf(resolve(dest, rel));
    const stockTarget = await realOf(resolve(dest, stockRel));
    for (const [what, at] of [[rel, target], [stockRel, stockTarget]] as const) {
      if (!inside(root, at)) return refuse('path_outside_repo', `the fetched path ${what} resolves outside the film repository`, { fetch: rel, path: what });
      const info = await lstat(at).catch(() => null);
      if (info && !info.isFile()) return refuse('path_outside_repo', `the fetched path ${what} is not a regular file`, { fetch: rel, path: what });
      if (owners.has(at)) return refuse('fetch_failed', `the fetched path ${what} is the file of the source ${owners.get(at)!}; nothing was written`, { path: rel });
    }
    if (fetchOwners.has(target)) return refuse('fetch_failed', `the fetch list names ${rel} twice, or beside a file's stock.json; nothing was written`, { path: rel });
    fetchOwners.set(target, rel);
    const disk = await fileSha(target);
    // A file the repository holds with its hash is never fetched again; its stock.json is checked as any file's is.
    const held = disk === entry.sha256;
    if (held) fetchUnchanged.push(rel);
    else if (disk !== null && !input.force) conflicts.push({ fetch: rel, path: rel, diskSha256: disk, sha256: entry.sha256 });
    let stock: StockPlan | null = null;
    const stockSha = sha256Hex(entry.stockJson);
    const shared = stockTexts.get(stockTarget);
    if (shared !== undefined) {
      // Two files of one folder share its record: one text writes it once; two texts are no record of either.
      if (shared !== entry.stockJson) return refuse('fetch_failed', `the fetch list gives ${stockRel} two records; nothing was written`, { path: rel });
    } else {
      if (fetchOwners.has(stockTarget)) return refuse('fetch_failed', `the fetch list names ${stockRel} as a file and as a record; nothing was written`, { path: rel });
      stockTexts.set(stockTarget, entry.stockJson);
      const stockDisk = await fileSha(stockTarget);
      if (stockDisk !== stockSha) {
        if (stockDisk !== null && !input.force) conflicts.push({ fetch: stockRel, path: stockRel, diskSha256: stockDisk, sha256: stockSha });
        stock = { rel: stockRel, target: stockTarget, disk: stockDisk, sha256: stockSha, forced: stockDisk !== null };
      }
    }
    if (held) {
      if (stock) heldStocks.push({ entry, file: rel, stock });
      continue;
    }
    fetchPlans.push({ entry, file: { rel, target, disk, forced: disk !== null }, stock, landings: [] });
  }
  for (const target of stockTexts.keys()) {
    if (fetchOwners.has(target)) return refuse('fetch_failed', `the fetch list names ${fetchOwners.get(target)!} as a file and as a record; nothing was written`, { path: fetchOwners.get(target)! });
  }

  if (conflicts.length > 0) {
    return refuse(
      'source_changed',
      `the repository changed since the last crossing: ${conflicts.map((c) => String(c.source ?? c.fetch)).join(', ')}; nothing was written (force writes over it, on his word alone)`,
      { conflicts },
    );
  }

  const writes = plans.filter((p) => p.action === 'write');
  let validated = false;
  if (writes.length > 0 || fetchPlans.length > 0 || heldStocks.length > 0) {
    // The first folder this write made, when the repository lacked writeTo: removed again unless the set lands.
    let made: string | undefined;
    let staged = '';
    try {
      made = await mkdir(dest, { recursive: true });
      staged = await mkdtemp(join(dest, '.wildweave-export-'));
    } catch (err) {
      if (made) await pruneEmpty(made);
      return refuse('export_write_failed', `the destination folder could not be made inside the film repository: ${(err as Error).message}`);
    }
    // Each file moved into place, with the hash of the bytes the export put there: a rollback undoes only a file still holding them.
    const restored: Array<{ label: Landing['label']; rel: string; target: string; backup: string | null; sha256: string }> = [];
    // The files saved over after the export moved them into place (an editor, while the engine checked the set): his
    // bytes, which a rollback keeps as he saved them and names, never removes or puts back over.
    const kept: Array<Landing['label'] & { path: string; diskSha256: string | null }> = [];
    // The files a rollback could not put back: their old bytes stay in the staging folder, named in the answer.
    const unrestored: Array<Landing['label'] & { path: string; keptAt: string }> = [];
    // The files the export made where the repository held none, that a rollback could not remove.
    const notRemoved: Array<Landing['label'] & { path: string }> = [];
    // The folders a file's landing made inside the repository: removed again, when left empty, unless the set lands.
    const madeFolders: string[] = [];
    let landed = false;

    const moved = (l: Landing, now: string | null) =>
      new SourceMovedError({ ...l.label, path: l.rel, diskSha256: now, ...(l.baseSha256 === undefined ? {} : { baseSha256: l.baseSha256 }), sha256: l.sha256 });

    /** Moves one staged file into place over the file the plan read, its backup made first, so a rollback only renames. */
    const land = async (l: Landing): Promise<void> => {
      // The file's folder and its backup come first, so a rollback only renames (it writes no byte, which a full
      // disk could refuse) and nothing but the hash stands between the file's last read and the rename over it.
      const folder = await mkdir(dirname(l.target), { recursive: true });
      if (folder) madeFolders.push(folder);
      const before = await fileBytes(l.target);
      const beforeSha = before === null ? null : sha256Hex(before);
      // A file that changed since the plan (an editor saved it while the engine checked the set) is not written
      // over unless forced; his force covers a change found here as it covers one the plan found.
      if (beforeSha !== l.disk) {
        if (!input.force) throw moved(l, beforeSha);
        l.forced = true;
      }
      // The backup is written from the bytes last read, then the file is read again: one that changed meanwhile is
      // refused unless forced, and forced it has its backup made again from the new bytes and is read once more, so
      // no step but the hash stands between the last read and the rename, and the backup holds what is replaced.
      const backup = join(staged, 'backup', l.rel);
      let held = before;
      let heldSha = beforeSha;
      for (let tries = 1; ; tries += 1) {
        if (held === null) {
          await rm(backup, { force: true });
        } else {
          await mkdir(dirname(backup), { recursive: true });
          await writeFile(backup, held);
        }
        const current = await fileBytes(l.target);
        const now = current === null ? null : sha256Hex(current);
        if (now === heldSha) break;
        // A file that keeps changing while its backup is written is refused, forced or not.
        if (!input.force || tries >= BACKUP_TRIES) throw moved(l, now);
        l.forced = true;
        held = current;
        heldSha = now;
      }
      const landedSha = sha256Hex(await readFile(l.staged));
      await rename(l.staged, l.target);
      restored.push({ label: l.label, rel: l.rel, target: l.target, backup: held === null ? null : backup, sha256: landedSha });
    };

    const fetchLandings: Landing[] = [];
    try {
      for (const p of writes) {
        const file = join(staged, 'files', p.rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, p.source.text, 'utf8');
      }
      // Each listed file into the staging folder, checked by its sha256 and its size, before any file moves: a fetch
      // that fails leaves the repository as it was. A file two entries share is fetched once.
      const got = new Map<string, { file: string; size: number }>();
      /** A record staged for its landing: the librarian's stock.json text the route gave. */
      const stageStock = async (entry: FetchEntry, stock: StockPlan): Promise<Landing> => {
        const record = join(staged, 'fetch', stock.rel);
        await mkdir(dirname(record), { recursive: true });
        await writeFile(record, entry.stockJson, 'utf8');
        return { label: { fetch: stock.rel }, rel: stock.rel, target: stock.target, staged: record, disk: stock.disk, sha256: stock.sha256, forced: stock.forced };
      };
      for (const fp of fetchPlans) {
        const { entry } = fp;
        const file = join(staged, 'fetch', fp.file.rel);
        await mkdir(dirname(file), { recursive: true });
        const earlier = got.get(entry.sha256);
        let size: number;
        if (earlier !== undefined) {
          await writeFile(file, await readFile(earlier.file));
          size = earlier.size;
        } else {
          const answer = await deps.client.file(entry.url, entry.sha256);
          if (!answer.ok) {
            throw new FetchFailedError(entry.path, answer.error.message, { code: answer.error.code, ...(answer.error.status === undefined ? {} : { status: answer.error.status }) });
          }
          const bytes = answer.result;
          const sha = sha256Hex(bytes);
          if (sha !== entry.sha256) throw new FetchFailedError(entry.path, `its bytes hash to ${sha}, not the listed ${entry.sha256}`, { code: 'sha256_mismatch', sha256: sha });
          await writeFile(file, bytes);
          size = bytes.byteLength;
          got.set(entry.sha256, { file, size });
        }
        // Every entry's listed size is checked, an entry sharing an earlier one's hash (and so its bytes) included.
        if (entry.bytes !== null && size !== entry.bytes) throw new FetchFailedError(entry.path, `it is ${size} bytes, not the listed ${entry.bytes}`, { code: 'size_mismatch', bytes: size });
        const landing: Landing = { label: { fetch: fp.file.rel }, rel: fp.file.rel, target: fp.file.target, staged: file, disk: fp.file.disk, sha256: entry.sha256, forced: fp.file.forced };
        fp.landings.push(landing);
        if (fp.stock) fp.landings.push(await stageStock(entry, fp.stock));
        fetchLandings.push(...fp.landings);
      }
      for (const h of heldStocks) {
        const landing = await stageStock(h.entry, h.stock);
        h.landing = landing;
        fetchLandings.push(landing);
      }
      // The fetched files and their records go into place first: the engine's cut reads every file under the assets root.
      for (const l of fetchLandings) await land(l);
      // What land found at each path decides `forced`: a file or a record that appeared or changed there while the set
      // was fetched, written over on his force, is reported as forced as one the plan found.
      for (const fp of fetchPlans) fp.file.forced = fp.landings.some((l) => l.forced);
      for (const h of heldStocks) if (h.landing) h.stock.forced = h.landing.forced;
      if (deps.engine) {
        const fileOf = (name: ExportSourceName): string => {
          const p = plans.find((plan) => plan.name === name);
          if (p && p.action === 'write') return join(staged, 'files', p.rel);
          return targets[name].target;
        };
        const cutFile = join(staged, 'cut.json');
        const cut = await deps.engine('cut', { timeline: fileOf('timeline'), sidecar: fileOf('sidecar'), takes: fileOf('takes'), assets: dest, out: cutFile, draft: true });
        if (!cut.ok) throw new ExportInvalidError(`the engine refused to cut the exported sources: ${cut.error.message}`, { engine: cut.error });
        const check = await deps.engine('validate', { cut: cutFile, assets: dest, draft: true });
        if (!check.ok) throw new ExportInvalidError(`the engine refused the exported cut: ${check.error.message}`, { engine: check.error });
        const result = isRec(check.result) ? check.result : {};
        if (result.ok === false) throw new ExportInvalidError('the exported cut holds an error finding; nothing was written', { findings: result.findings ?? [] });
        validated = true;
      }
      for (const p of writes) {
        const l: Landing = { label: { source: p.name }, rel: p.rel, target: p.target, staged: join(staged, 'files', p.rel), disk: p.disk, sha256: p.source.sha256, baseSha256: p.source.baseSha256, forced: p.forced };
        try {
          await land(l);
        } finally {
          p.forced = l.forced;
        }
      }
      landed = true;
    } catch (err) {
      for (const done of restored.reverse()) {
        // A file that no longer holds the export's bytes was saved over after it landed: his save stays, and is named.
        // One the rollback cannot read is undone as before.
        const now = await fileSha(done.target).catch(() => done.sha256);
        if (now !== done.sha256) {
          kept.push({ ...done.label, path: done.rel, diskSha256: now });
          continue;
        }
        if (done.backup === null) {
          try {
            await rm(done.target, { force: true });
          } catch {
            notRemoved.push({ ...done.label, path: done.rel });
          }
          continue;
        }
        try {
          await rename(done.backup, done.target);
        } catch {
          unrestored.push({ ...done.label, path: done.rel, keptAt: relative(root, done.backup).split(sep).join('/') });
        }
      }
      for (const folder of madeFolders.reverse()) await pruneEmpty(folder);
      const left: string[] = [];
      if (unrestored.length > 0) {
        left.push(`${unrestored.map((u) => u.path).join(', ')} could not be put back: each holds the export's text, and its old bytes are kept at ${unrestored.map((u) => u.keptAt).join(', ')}`);
      }
      if (notRemoved.length > 0) {
        left.push(`${notRemoved.map((u) => u.path).join(', ')} could not be removed: each holds the export's text where the repository held no file`);
      }
      if (kept.length > 0) {
        left.push(`${kept.map((k) => k.path).join(', ')} changed after the export moved it into place, so it is kept as it was saved`);
      }
      const undone = left.length === 0 ? 'the files already moved were put back' : left.join('; ');
      const details = {
        ...(unrestored.length === 0 ? {} : { unrestored }),
        ...(notRemoved.length === 0 ? {} : { notRemoved }),
        ...(kept.length === 0 ? {} : { kept }),
      };
      if (err instanceof FetchFailedError) {
        return refuse('fetch_failed', `fetching ${err.path} through the files route failed (${err.message}); nothing was written and nothing was acknowledged`, { path: err.path, ...err.info, ...details });
      }
      if (err instanceof ExportInvalidError) {
        return refuse('export_invalid', left.length === 0 ? err.message : `${err.message}; ${undone}`, { ...err.details, ...details });
      }
      if (err instanceof SourceMovedError) {
        return refuse(
          'source_changed',
          `the repository changed ${String(err.conflict.source ?? err.conflict.fetch)} while the export was checked; ${undone}, and nothing was acknowledged (force writes over it, on his word alone)`,
          { conflicts: [err.conflict], ...details },
        );
      }
      return refuse('export_write_failed', `writing the sources failed; ${undone}: ${(err as Error).message}`, Object.keys(details).length === 0 ? undefined : details);
    } finally {
      // The staging folder stays while it holds the only copy of a file the rollback could not put back.
      if (unrestored.length === 0) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      // Only the folders left empty: a file saved into a folder this export made, while the set was checked, stays.
      if (!landed && made) await pruneEmpty(made);
    }
  }

  const written = writes.map((p) => ({ source: p.name, path: p.rel, sha256: p.source.sha256, forced: p.forced }));
  const unchanged = plans.filter((p) => p.action === 'same').map((p) => p.name);
  const fetched = fetchPlans.map((fp) => ({
    path: fp.file.rel,
    sha256: fp.entry.sha256,
    bytes: fp.entry.bytes,
    stock: posix.join(posix.dirname(fp.file.rel), 'stock.json'),
    forced: fp.file.forced,
  }));
  const stockWritten = heldStocks.map((h) => ({ path: h.stock.rel, file: h.file, forced: h.stock.forced }));
  const reported = Object.fromEntries(
    Object.entries(sources).map(([name, s]) => [name, { sha256: s.sha256, baseSha256: s.baseSha256, changed: s.changed, notes: s.notes }]),
  );
  // Every source the repository now holds as exported, whose base the record does not hold yet.
  const ack = Object.fromEntries(plans.filter((p) => p.source.baseSha256 !== p.source.sha256).map((p) => [p.name, p.source.sha256]));
  const result: Record<string, unknown> = { recordFormat, sources: reported, written, unchanged, validated, fetched, fetchUnchanged, stockWritten };
  if (Object.keys(ack).length === 0) return { ok: true, result, requestId: exported.requestId };
  const acked = await deps.client.acknowledge(input.filmId, { ack, ifUpdatedAtMs: updatedAtMs });
  if (!acked.ok) {
    return {
      ok: false,
      error: {
        ...acked.error,
        message: `the sources were written${fetched.length + stockWritten.length > 0 ? ' and the fetched files and records placed, and all stay' : ''}; the acknowledgement was refused: ${acked.error.message}`,
        details: { ...(acked.error.details ?? {}), written, fetched, stockWritten },
      },
    };
  }
  return { ok: true, result: { ...result, ack: acked.result }, requestId: acked.requestId };
}
