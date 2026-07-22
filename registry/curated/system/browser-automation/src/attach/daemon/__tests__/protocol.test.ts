import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newCmdId,
  writeAtomicJson,
  readJson,
  cmdPath,
  respPath,
  listPendingCmds,
  gcStale,
  STALE_FILE_MS,
} from '../protocol.js';

const dirs: string[] = [];
const tdir = () => {
  const d = mkdtempSync(join(tmpdir(), 'attach-ipc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('protocol', () => {
  it('ids are strings and survive a JSON round trip at time_ns scale', () => {
    const id = newCmdId('cli');
    expect(typeof id).toBe('string');
    expect(id.startsWith('cli-')).toBe(true);
    // the historical bug: 1753112793123456789 > 2^53 rounds as a JS number
    const echoed = JSON.parse(JSON.stringify({ id: 'cli-1753112793123456789-x' }));
    expect(echoed.id).toBe('cli-1753112793123456789-x');
  });

  it('writeAtomicJson leaves no .tmp behind and readJson round-trips', () => {
    const d = tdir();
    const f = join(d, 'x.json');
    writeAtomicJson(f, { a: 1 });
    expect(readJson<{ a: number }>(f)).toEqual({ a: 1 });
    expect(readdirSync(d).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('readJson returns undefined for missing or torn files', () => {
    const d = tdir();
    expect(readJson(join(d, 'missing.json'))).toBeUndefined();
    writeFileSync(join(d, 'torn.json'), '{not json');
    expect(readJson(join(d, 'torn.json'))).toBeUndefined();
  });

  it('listPendingCmds returns cmd-* files oldest-first and ignores responses and temp files', () => {
    const d = tdir();
    writeAtomicJson(cmdPath(d, 'b'), { id: 'b' });
    writeAtomicJson(cmdPath(d, 'a'), { id: 'a' });
    writeAtomicJson(respPath(d, 'zzz'), { id: 'zzz' });
    writeFileSync(join(d, 'cmd-torn.json.tmp'), '{');
    const past = new Date(Date.now() - 5000);
    utimesSync(cmdPath(d, 'b'), past, past);
    expect(listPendingCmds(d).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('gcStale removes cmd/resp files older than STALE_FILE_MS and keeps fresh ones', () => {
    const d = tdir();
    writeAtomicJson(cmdPath(d, 'old'), { id: 'old' });
    writeAtomicJson(respPath(d, 'old'), { id: 'old' });
    writeAtomicJson(cmdPath(d, 'new'), { id: 'new' });
    const past = new Date(Date.now() - STALE_FILE_MS - 1000);
    utimesSync(cmdPath(d, 'old'), past, past);
    utimesSync(respPath(d, 'old'), past, past);
    gcStale(d);
    expect(existsSync(cmdPath(d, 'old'))).toBe(false);
    expect(existsSync(respPath(d, 'old'))).toBe(false);
    expect(existsSync(cmdPath(d, 'new'))).toBe(true);
  });

  it('gcStale with now=Infinity sweeps every queue file regardless of age', () => {
    const d = tdir();
    writeAtomicJson(cmdPath(d, 'x'), { id: 'x' });
    writeAtomicJson(respPath(d, 'y'), { id: 'y' });
    gcStale(d, Number.POSITIVE_INFINITY);
    expect(readdirSync(d).filter((n) => n.startsWith('cmd-') || n.startsWith('resp-'))).toEqual([]);
  });
});
