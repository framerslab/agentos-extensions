import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The file-system calls the export makes, watched: a test saves a file the moment one of them runs. */
const watch = vi.hoisted(() => ({ onMkdir: undefined as undefined | ((path: string) => void) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const mkdir = ((...args: Parameters<typeof real.mkdir>) => {
    watch.onMkdir?.(String(args[0]));
    return real.mkdir(...args);
  }) as unknown as typeof real.mkdir;
  const mocked = { ...real, mkdir };
  return { ...mocked, default: mocked };
});

import type { WildweaveStudioClient } from '../src/client.js';
import { DEFAULT_SOURCE_PATHS, exportFilm } from '../src/export.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-window-'));
});
afterEach(() => {
  watch.onMkdir = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

/** A studio that answers the export's three calls: the timeline, the sources, and the acknowledgement. */
function fakeStudio(texts: Record<string, string>, base: Record<string, string>) {
  const acks: unknown[] = [];
  const client = {
    timeline: async () => ({ ok: true, status: 200, requestId: 'req-timeline', result: { updatedAtMs: { timeline: 1 } } }),
    exportSources: async () => ({
      ok: true,
      status: 200,
      requestId: 'req-export',
      result: {
        recordFormat: 2,
        sources: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, { text, sha256: sha256Hex(text), baseSha256: base[name] ?? null, changed: true, notes: [] }])),
      },
    }),
    acknowledge: async (_filmId: string, body: unknown) => {
      acks.push(body);
      return { ok: true, status: 200, requestId: 'req-ack', result: { seq: 1, sources: {}, rebound: false } };
    },
  } as unknown as WildweaveStudioClient;
  return { client, acks };
}

describe('the export between its last read of a file and the rename over it', () => {
  it('runs no other step there: a save made as the folder for the file is made is read, and not written over', async () => {
    const paths = { ...DEFAULT_SOURCE_PATHS, sidecar: 'production/sidecar/render.json' };
    const film = join(scratch, 'film');
    for (const [name, rel] of Object.entries(paths)) {
      mkdirSync(dirname(join(film, rel)), { recursive: true });
      writeFileSync(join(film, rel), `old ${name}\n`);
    }
    const root = realpathSync(film);
    const texts = Object.fromEntries(Object.keys(paths).map((name) => [name, `new ${name}\n`]));
    const base = Object.fromEntries(Object.keys(paths).map((name) => [name, sha256Hex(`old ${name}\n`)]));
    const { client, acks } = fakeStudio(texts, base);
    const sidecar = join(root, paths.sidecar);
    let checked = false;
    let saved = false;
    // After the engine checked the set, an editor saves the sidecar just as the export makes the sidecar's folder.
    watch.onMkdir = (path) => {
      if (checked && !saved && path === dirname(sidecar)) {
        saved = true;
        writeFileSync(sidecar, 'saved by an editor\n');
      }
    };
    const engine = async (subcommand: string) => {
      if (subcommand === 'validate') checked = true;
      return { ok: true as const, result: subcommand === 'validate' ? { ok: true, findings: [] } : {} };
    };

    const answer = await exportFilm({ filmId: 'film-demo-0001', writeTo: '.', paths: { sidecar: paths.sidecar } }, { client, filmRepo: root, engine });

    expect(saved).toBe(true);
    expect(answer).toMatchObject({ ok: false, error: { code: 'source_changed', details: { conflicts: [{ source: 'sidecar', diskSha256: sha256Hex('saved by an editor\n') }] } } });
    expect(readFileSync(sidecar, 'utf8')).toBe('saved by an editor\n');
    for (const name of ['script', 'beatSheet', 'takes', 'timeline'] as const) expect(readFileSync(join(root, paths[name]), 'utf8')).toBe(`old ${name}\n`);
    expect(acks).toEqual([]);
  });
});
