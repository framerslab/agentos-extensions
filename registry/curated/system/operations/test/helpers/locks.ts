/**
 * The try-lock numbers each test file gives its jobs. PostgreSQL's advisory locks belong to the
 * database, not to a table prefix, and the test files run in parallel against one database, so two
 * files whose sweep or totals take the same numbers make each other's run come back `skipped`.
 * Each file takes three numbers no other file takes, from its place among the test files sorted by
 * name.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { expect } from 'vitest';

/** The number the first test file's three locks start at. */
const LOCK_BASE = 10_000;

/** The path of the test file running now. */
function runningFile(): string {
  const path = expect.getState().testPath;
  if (!path) throw new Error('locks: no test file is running');
  return path;
}

/**
 * The package's test files by name, sorted: the order that gives each file its locks. They are the files beside the
 * one running now, read from its path rather than from this module's URL: under jsdom, `fileURLToPath(new URL('..',
 * import.meta.url))` threw `ERR_INVALID_URL_SCHEME`.
 */
export function testFileNames(): string[] {
  return readdirSync(dirname(runningFile()))
    .filter((name) => /\.test\.tsx?$/.test(name))
    .sort();
}

/** The tick, sweep and totals locks of the test file at `file`, a path or a name. */
export function locksOf(file: string): readonly [tick: number, sweep: number, totals: number] {
  const index = testFileNames().indexOf(basename(file));
  if (index < 0) throw new Error(`locksOf: ${basename(file)} is not a test file of this package`);
  const first = LOCK_BASE + 3 * index;
  return [first, first + 1, first + 2];
}

/** The locks of the test file running now. */
export function ownLocks(): readonly [tick: number, sweep: number, totals: number] {
  return locksOf(runningFile());
}
