/**
 * @module @framers/agentos-ext-wildweave-film/export
 *
 * The export's write into the film repository: all or nothing, and never over a change the
 * repository made since the last crossing.
 *
 * 1. The timeline is read for the edit times the acknowledgement is guarded by, then the export
 *    route answers each source's text, sha256 and `baseSha256` (the file's hash as the repository
 *    last held it).
 * 2. Each source's file is resolved under `writeTo` (the repository root, or a folder inside it,
 *    made when the repository lacks it), symlinks included, and must lie inside
 *    `WILDWEAVE_FILM_REPO`; `force` never lifts this. Every source's path is checked, the ones the
 *    route leaves out too, since the engine's cut reads them, and no two sources may resolve to one
 *    file (`arg_invalid`).
 * 3. A file already holding the export is left alone; a file whose hash is the base (or a file
 *    absent while the record holds no base) is written; any other is the repository moving since,
 *    reported `source_changed` with both hashes, and nothing is written unless `force`.
 * 4. The set is written into a folder inside the destination, cut and validated by the engine when
 *    an engine directory is configured (an error refuses the set, `export_invalid`), then renamed
 *    into place. Each file is read again right before its rename: one that changed since step 3 (an
 *    editor saved it while the engine checked the set) refuses the set, `source_changed`, unless
 *    `force` (it is then written over and reported forced). Each file's folder and backup are made
 *    before that last read, so only the hash stands between the read and the rename; a save landing
 *    in that instant is still written over, since no file-system call renames only over an unchanged
 *    file. A failure part way renames the backups back over the files it replaced, writing nothing,
 *    and names any it could not put back with where its old bytes are kept (the staging folder then
 *    stays); of the folders it made it removes only the ones left empty.
 * 5. The written hashes are acknowledged to the route, so the next export compares against them.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

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

/** A file the repository changed between the plan and its rename. */
class SourceMovedError extends Error {
  readonly conflict: Record<string, unknown>;

  constructor(conflict: Record<string, unknown>) {
    super(`the repository changed ${String(conflict.source)} while the export was checked`);
    this.name = 'SourceMovedError';
    this.conflict = conflict;
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

  // The edit times first: an edit landing between this read and the export makes the acknowledgement stale, never wrong.
  const timeline: StudioAnswer = await deps.client.timeline(input.filmId);
  if (!timeline.ok) return timeline;
  const updatedAtMs = isRec(timeline.result) && isRec(timeline.result.updatedAtMs) ? (timeline.result.updatedAtMs as Record<string, number>) : {};
  const exported = await deps.client.exportSources(input.filmId);
  if (!exported.ok) return exported;
  const sources = routeSources(exported.result);
  const recordFormat = isRec(exported.result) ? exported.result.recordFormat : undefined;

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
  if (conflicts.length > 0) {
    return refuse('source_changed', `the repository changed since the last crossing: ${conflicts.map((c) => c.source).join(', ')}; nothing was written (force writes over it, on his word alone)`, { conflicts });
  }

  const writes = plans.filter((p) => p.action === 'write');
  let validated = false;
  if (writes.length > 0) {
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
    const restored: Array<{ name: ExportSourceName; rel: string; target: string; backup: string | null }> = [];
    // The files a rollback could not put back: their old bytes stay in the staging folder, named in the answer.
    const unrestored: Array<{ source: ExportSourceName; path: string; keptAt: string }> = [];
    let landed = false;
    try {
      for (const p of writes) {
        const file = join(staged, 'files', p.rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, p.source.text, 'utf8');
      }
      if (deps.engine) {
        const fileOf = (name: ExportSourceName): string => {
          const p = plans.find((plan) => plan.name === name);
          if (p && p.action === 'write') return join(staged, 'files', p.rel);
          return targets[name].target;
        };
        const cutFile = join(staged, 'cut.json');
        const cut = await deps.engine('cut', { timeline: fileOf('timeline'), sidecar: fileOf('sidecar'), takes: fileOf('takes'), assets: dest, out: cutFile, draft: true });
        if (!cut.ok) return refuse('export_invalid', `the engine refused to cut the exported sources: ${cut.error.message}`, { engine: cut.error });
        const check = await deps.engine('validate', { cut: cutFile, assets: dest, draft: true });
        if (!check.ok) return refuse('export_invalid', `the engine refused the exported cut: ${check.error.message}`, { engine: check.error });
        const result = isRec(check.result) ? check.result : {};
        if (result.ok === false) return refuse('export_invalid', 'the exported cut holds an error finding; nothing was written', { findings: result.findings ?? [] });
        validated = true;
      }
      const moved = (p: Plan, now: string | null) => new SourceMovedError({ source: p.name, path: p.rel, diskSha256: now, baseSha256: p.source.baseSha256, sha256: p.source.sha256 });
      for (const p of writes) {
        // The file's folder and its backup come first, so a rollback only renames (it writes no byte, which a full
        // disk could refuse) and nothing but the hash stands between the file's last read and the rename over it.
        await mkdir(dirname(p.target), { recursive: true });
        const before = await fileBytes(p.target);
        const beforeSha = before === null ? null : sha256Hex(before);
        // A file that changed since the plan (an editor saved it while the engine checked the set) is not written
        // over unless forced; his force covers a change found here as it covers one the plan found.
        if (beforeSha !== p.disk) {
          if (!input.force) throw moved(p, beforeSha);
          p.forced = true;
        }
        const backup = join(staged, 'backup', p.rel);
        if (before !== null) {
          await mkdir(dirname(backup), { recursive: true });
          await writeFile(backup, before);
        }
        // The last read, then the rename.
        const current = await fileBytes(p.target);
        const now = current === null ? null : sha256Hex(current);
        if (now !== beforeSha) {
          if (!input.force) throw moved(p, now);
          // Forced over a save made while its backup was written: the backup is made again from what is replaced.
          p.forced = true;
          if (current === null) {
            await rm(backup, { force: true });
          } else {
            await mkdir(dirname(backup), { recursive: true });
            await writeFile(backup, current);
          }
        }
        await rename(join(staged, 'files', p.rel), p.target);
        restored.push({ name: p.name, rel: p.rel, target: p.target, backup: current === null ? null : backup });
      }
      landed = true;
    } catch (err) {
      for (const done of restored.reverse()) {
        if (done.backup === null) {
          await rm(done.target, { force: true }).catch(() => undefined);
          continue;
        }
        try {
          await rename(done.backup, done.target);
        } catch {
          unrestored.push({ source: done.name, path: done.rel, keptAt: relative(root, done.backup).split(sep).join('/') });
        }
      }
      const kept =
        unrestored.length === 0
          ? 'the files already moved were put back'
          : `${unrestored.map((u) => u.path).join(', ')} could not be put back: each holds the export's text, and its old bytes are kept at ${unrestored.map((u) => u.keptAt).join(', ')}`;
      const details = unrestored.length === 0 ? {} : { unrestored };
      if (err instanceof SourceMovedError) {
        return refuse(
          'source_changed',
          `the repository changed ${String(err.conflict.source)} while the export was checked; ${kept}, and nothing was acknowledged (force writes over it, on his word alone)`,
          { conflicts: [err.conflict], ...details },
        );
      }
      return refuse('export_write_failed', `writing the sources failed; ${kept}: ${(err as Error).message}`, unrestored.length === 0 ? undefined : details);
    } finally {
      // The staging folder stays while it holds the only copy of a file the rollback could not put back.
      if (unrestored.length === 0) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
      // Only the folders left empty: a file saved into a folder this export made, while the set was checked, stays.
      if (!landed && made) await pruneEmpty(made);
    }
  }

  const written = writes.map((p) => ({ source: p.name, path: p.rel, sha256: p.source.sha256, forced: p.forced }));
  const unchanged = plans.filter((p) => p.action === 'same').map((p) => p.name);
  const reported = Object.fromEntries(
    Object.entries(sources).map(([name, s]) => [name, { sha256: s.sha256, baseSha256: s.baseSha256, changed: s.changed, notes: s.notes }]),
  );
  // Every source the repository now holds as exported, whose base the record does not hold yet.
  const ack = Object.fromEntries(plans.filter((p) => p.source.baseSha256 !== p.source.sha256).map((p) => [p.name, p.source.sha256]));
  const result: Record<string, unknown> = { recordFormat, sources: reported, written, unchanged, validated };
  if (Object.keys(ack).length === 0) return { ok: true, result, requestId: exported.requestId };
  const acked = await deps.client.acknowledge(input.filmId, { ack, ifUpdatedAtMs: updatedAtMs });
  if (!acked.ok) {
    return {
      ok: false,
      error: { ...acked.error, message: `the sources were written; the acknowledgement was refused: ${acked.error.message}`, details: { ...(acked.error.details ?? {}), written } },
    };
  }
  return { ok: true, result: { ...result, ack: acked.result }, requestId: acked.requestId };
}
