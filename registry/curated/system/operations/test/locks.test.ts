/**
 * The test files run in parallel against one PostgreSQL database, where an advisory lock is the
 * database's, whatever table prefix a file uses. A file whose sweep or totals take the try-lock
 * numbers of another file's makes that file's run come back `skipped`, so each file's fixture
 * takes numbers of its own, and a file that writes its locks out by hand takes none of another's.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { describe, expect, it } from 'vitest';
import { fixtureOptions } from './helpers/host.js';
import { locksOf, ownLocks, testFileNames } from './helpers/locks.js';

/** A `locks` option written out in a test's source: an array literal of numbers. */
const LOCKS_LITERAL = /\blocks:\s*\[([^\]]*)\]/g;

/**
 * The lock numbers `source` writes out as a `locks` option that could take a lock: three distinct
 * safe integers, as `createOperations` accepts. A set it refuses, such as the options test's two
 * locks, takes none.
 */
function literalLocks(source: string): number[] {
  const found: number[] = [];
  for (const match of source.matchAll(LOCKS_LITERAL)) {
    const numbers = match[1]!.split(',').map((part) => Number(part.trim().replace(/_/g, '')));
    if (numbers.length === 3 && numbers.every((n) => Number.isSafeInteger(n)) && new Set(numbers).size === 3) found.push(...numbers);
  }
  return found;
}

describe('the try-locks of the test files', () => {
  it("no two test files take the same lock number, whether from the fixture or written out in a file's source", () => {
    const files = testFileNames();
    expect(files).toContain('locks.test.ts');
    expect(files).toContain('sweep.test.ts');
    const directory = dirname(expect.getState().testPath!);
    const taken = new Map<number, string>();
    const take = (lock: number, file: string) => {
      const holder = taken.get(lock);
      expect(holder === undefined || holder === file, `${file} and ${holder} both take lock ${lock}`).toBe(true);
      taken.set(lock, file);
    };
    for (const file of files) for (const lock of locksOf(file)) take(lock, file);
    expect(taken.size).toBe(3 * files.length);
    // This file's own written-out sets are samples for the reader below, never options a job runs with.
    for (const file of files.filter((name) => name !== 'locks.test.ts')) {
      for (const lock of literalLocks(readFileSync(join(directory, file), 'utf8'))) take(lock, file);
    }
  });

  it('reads a written-out lock set that could take a lock, and none that createOperations refuses', () => {
    expect(literalLocks("build({ options: { locks: [7201, 7202, 7203] } })")).toEqual([7201, 7202, 7203]);
    expect(literalLocks('{ locks: [1, 2] }, { locks: [1, 1, 2] }, { locks: [1, 2, 2.5] }')).toEqual([]);
    // A file that wrote out another file's numbers is the collision the test above refuses.
    const sweeps = locksOf('sweep.test.ts');
    expect(literalLocks(`{ locks: [${sweeps.join(', ')}] }`)).toEqual([...sweeps]);
  });

  it("the fixture host takes the running file's own locks", () => {
    const options = fixtureOptions({} as StorageAdapter).options;
    expect(options.locks).toEqual(locksOf('locks.test.ts'));
    expect(options.locks).toEqual(ownLocks());
    expect(options.locks).not.toEqual(locksOf('sweep.test.ts'));
  });
});
