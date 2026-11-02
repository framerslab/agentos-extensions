import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The file-system calls the export makes, watched: a test saves a file the moment one of them runs,
 * fills the disk (every later write fails ENOSPC), or makes the repository's files busy (every later
 * rename into the repository or removal from it fails EBUSY, as Windows answers for a file an editor
 * holds open).
 */
const watch = vi.hoisted(() => ({
  onMutation: undefined as undefined | ((call: 'mkdir' | 'writeFile', path: string) => void),
  full: false,
  busy: false,
  /** The disk fills once a first file is renamed into the repository. */
  fillAfterMove: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const failure = (code: string, message: string) => Object.assign(new Error(`${code}: ${message}`), { code });
  const mkdir = ((...args: Parameters<typeof real.mkdir>) => {
    watch.onMutation?.('mkdir', String(args[0]));
    return real.mkdir(...args);
  }) as unknown as typeof real.mkdir;
  const writeFile = ((...args: Parameters<typeof real.writeFile>) => {
    watch.onMutation?.('writeFile', String(args[0]));
    if (watch.full) return Promise.reject(failure('ENOSPC', 'no space left on device, write'));
    return real.writeFile(...args);
  }) as unknown as typeof real.writeFile;
  const rename = ((...args: Parameters<typeof real.rename>) => {
    const intoRepository = !String(args[1]).includes('.wildweave-export-');
    if (watch.busy && intoRepository) return Promise.reject(failure('EBUSY', 'resource busy or locked, rename'));
    return real.rename(...args).then(() => {
      if (watch.fillAfterMove && intoRepository) watch.full = true;
    });
  }) as unknown as typeof real.rename;
  const rm = ((...args: Parameters<typeof real.rm>) => {
    if (watch.busy && !String(args[0]).includes('.wildweave-export-')) return Promise.reject(failure('EBUSY', 'resource busy or locked, rm'));
    return real.rm(...args);
  }) as unknown as typeof real.rm;
  const mocked = { ...real, mkdir, writeFile, rename, rm };
  return { ...mocked, default: mocked };
});

import type { WildweaveStudioClient } from '../src/client.js';
import { DEFAULT_SOURCE_PATHS, exportFilm } from '../src/export.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The sources, with the sidecar in a folder of its own so a test can tell its folder apart. */
const PATHS = { ...DEFAULT_SOURCE_PATHS, sidecar: 'production/sidecar/render.json' };
const NAMES = Object.keys(PATHS) as Array<keyof typeof PATHS>;
const EARLIER = ['script', 'beatSheet', 'takes', 'timeline'] as const;
const SAVED = 'saved by an editor\n';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-window-'));
});
afterEach(() => {
  watch.onMutation = undefined;
  watch.full = false;
  watch.busy = false;
  watch.fillAfterMove = false;
  rmSync(scratch, { recursive: true, force: true });
});

/** A film repository holding the old text of every source, under its real path. */
function filmRepo(name: string): { root: string; sidecar: string } {
  const film = join(scratch, name);
  for (const source of NAMES) {
    mkdirSync(dirname(join(film, PATHS[source])), { recursive: true });
    writeFileSync(join(film, PATHS[source]), `old ${source}\n`);
  }
  const root = realpathSync(film);
  return { root, sidecar: join(root, PATHS.sidecar) };
}

/** The export into `root`, the studio answering the new texts over the old bases, the engine passing the set. */
async function runExport(root: string, onChecked: () => void = () => undefined, force?: boolean, bases: 'old' | 'none' = 'old') {
  const acks: unknown[] = [];
  const client = {
    timeline: async () => ({ ok: true, status: 200, requestId: 'req-timeline', result: { updatedAtMs: { timeline: 1 } } }),
    exportSources: async () => ({
      ok: true,
      status: 200,
      requestId: 'req-export',
      result: {
        recordFormat: 2,
        sources: Object.fromEntries(NAMES.map((name) => [name, { text: `new ${name}\n`, sha256: sha256Hex(`new ${name}\n`), baseSha256: bases === 'old' ? sha256Hex(`old ${name}\n`) : null, changed: true, notes: [] }])),
      },
    }),
    acknowledge: async (_filmId: string, body: unknown) => {
      acks.push(body);
      return { ok: true, status: 200, requestId: 'req-ack', result: { seq: 1, sources: {}, rebound: false } };
    },
  } as unknown as WildweaveStudioClient;
  const engine = async (subcommand: string) => {
    if (subcommand === 'validate') onChecked();
    return { ok: true as const, result: subcommand === 'validate' ? { ok: true, findings: [] } : {} };
  };
  const answer = await exportFilm({ filmId: 'film-demo-0001', writeTo: '.', paths: { sidecar: PATHS.sidecar }, ...(force === undefined ? {} : { force }) }, { client, filmRepo: root, engine });
  return { answer, acks };
}

/** Saves the sidecar (and fills the disk or makes the files busy, when asked) as the export makes the sidecar's folder. */
function saveAtSidecarFolder(sidecar: string, then: { full?: boolean; busy?: boolean } = {}): { checked: () => void; saved: () => boolean } {
  let checked = false;
  let saved = false;
  watch.onMutation = (call, path) => {
    if (!checked || saved || call !== 'mkdir' || path !== dirname(sidecar)) return;
    saved = true;
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, SAVED);
    if (then.full) watch.full = true;
    if (then.busy) watch.busy = true;
  };
  return { checked: () => (checked = true), saved: () => saved };
}

describe('the export after the engine checked the set', () => {
  it('never writes over a save made at any step it takes there, the steps between its last read of a file and the rename over it included', async () => {
    // A clean run first, to count the folders and files the export makes once the set is checked.
    const clean = filmRepo('clean');
    let checked = false;
    let steps = 0;
    watch.onMutation = () => {
      if (checked) steps += 1;
    };
    const landed = await runExport(clean.root, () => (checked = true));
    expect(landed.answer.ok).toBe(true);
    expect(steps).toBeGreaterThanOrEqual(NAMES.length);

    for (let k = 1; k <= steps; k += 1) {
      const { root, sidecar } = filmRepo(`save-at-${k}`);
      let after = false;
      let seen = 0;
      watch.onMutation = () => {
        if (after && ++seen === k) writeFileSync(sidecar, SAVED);
      };
      const { answer, acks } = await runExport(root, () => (after = true));
      expect({ k, answer }).toMatchObject({ k, answer: { ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar', diskSha256: sha256Hex(SAVED) }] } } } });
      expect(readFileSync(sidecar, 'utf8')).toBe(SAVED);
      for (const name of EARLIER) expect({ k, name, text: readFileSync(join(root, PATHS[name]), 'utf8') }).toEqual({ k, name, text: `old ${name}\n` });
      expect(acks).toEqual([]);
    }
  });

  it('puts back the files already moved without writing a byte, so a full disk cannot keep them from coming back', async () => {
    const { root, sidecar } = filmRepo('full');
    const at = saveAtSidecarFolder(sidecar, { full: true });
    const { answer, acks } = await runExport(root, at.checked);
    expect(at.saved()).toBe(true);
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar' }] } } });
    for (const name of EARLIER) expect({ name, text: readFileSync(join(root, PATHS[name]), 'utf8') }).toEqual({ name, text: `old ${name}\n` });
    expect(readFileSync(sidecar, 'utf8')).toBe(SAVED);
    expect(acks).toEqual([]);
  });

  it('names each file it could not put back and keeps its old bytes where it says, never claiming them put back', async () => {
    const { root, sidecar } = filmRepo('busy');
    const at = saveAtSidecarFolder(sidecar, { busy: true });
    const { answer, acks } = await runExport(root, at.checked);
    expect(at.saved()).toBe(true);
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar' }] } } });
    const error = (answer as unknown as { ok: false; error: { message: string; details: { unrestored: Array<{ source: string; path: string; keptAt: string }> } } }).error;
    expect(error.message).toContain('could not be put back');
    expect(error.details.unrestored.map((u) => u.source).sort()).toEqual([...EARLIER].sort());
    for (const kept of error.details.unrestored) {
      expect(kept.path).toBe(PATHS[kept.source as keyof typeof PATHS]);
      expect({ source: kept.source, text: readFileSync(join(root, kept.keptAt), 'utf8') }).toEqual({ source: kept.source, text: `old ${kept.source}\n` });
    }
    expect(acks).toEqual([]);
  });

  it('forced over saves made while it writes a backup, keeps the newest save as the backup, so a later failure puts that one back', async () => {
    const { root } = filmRepo('forced-saves');
    const script = join(root, PATHS.script);
    let checked = false;
    let writes = 0;
    // Once the set is checked, an editor saves the script at the export's first write and again at its second (both
    // backups of the script), and the disk fills once the script is moved, so the next backup fails.
    watch.onMutation = (call) => {
      if (!checked || call !== 'writeFile') return;
      writes += 1;
      if (writes === 1) writeFileSync(script, 'save 1\n');
      if (writes === 2) writeFileSync(script, 'save 2\n');
    };
    watch.fillAfterMove = true;
    const { answer, acks } = await runExport(root, () => (checked = true), true);
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(answer).toMatchObject({ ok: false, error: { code: 'export_write_failed' } });
    expect(readFileSync(script, 'utf8')).toBe('save 2\n');
    for (const name of ['beatSheet', 'takes', 'timeline', 'sidecar'] as const) expect({ name, text: readFileSync(join(root, PATHS[name]), 'utf8') }).toEqual({ name, text: `old ${name}\n` });
    expect(acks).toEqual([]);
  });

  it('names each file it made that it could not remove, never claiming the repository is as it was', async () => {
    // A repository that holds none of the sources yet, and a record that holds no base: every source is a new file.
    const fresh = join(scratch, 'fresh');
    mkdirSync(fresh, { recursive: true });
    const root = realpathSync(fresh);
    const sidecar = join(root, PATHS.sidecar);
    const at = saveAtSidecarFolder(sidecar, { busy: true });
    const { answer, acks } = await runExport(root, at.checked, undefined, 'none');
    expect(at.saved()).toBe(true);
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar' }] } } });
    const error = (answer as unknown as { ok: false; error: { message: string; details: { notRemoved: Array<{ source: string; path: string }> } } }).error;
    expect(error.message).toContain('could not be removed');
    expect(error.message).not.toContain('were put back');
    expect(error.details.notRemoved.map((u) => u.source).sort()).toEqual([...EARLIER].sort());
    for (const left of error.details.notRemoved) {
      expect(left.path).toBe(PATHS[left.source as keyof typeof PATHS]);
      expect({ source: left.source, text: readFileSync(join(root, left.path), 'utf8') }).toEqual({ source: left.source, text: `new ${left.source}\n` });
    }
    expect(readFileSync(sidecar, 'utf8')).toBe(SAVED);
    expect(acks).toEqual([]);
  });
});
