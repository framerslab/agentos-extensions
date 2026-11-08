/**
 * The test files run in parallel against one PostgreSQL database, where an advisory lock is the
 * database's, whatever table prefix a file uses. A file whose sweep or totals take the try-lock
 * numbers of another file's makes that file's run come back `skipped`, so each file's fixture
 * takes numbers of its own.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { describe, expect, it } from 'vitest';
import { fixtureOptions } from './helpers/host.js';
import { locksOf, ownLocks, testFileNames } from './helpers/locks.js';

describe('the try-locks of the test files', () => {
  it('no two test files take the same lock number', () => {
    const files = testFileNames();
    expect(files).toContain('locks.test.ts');
    expect(files).toContain('sweep.test.ts');
    const taken = new Map<number, string>();
    for (const file of files) {
      for (const lock of locksOf(file)) {
        expect(taken.get(lock), `${file} and ${taken.get(lock)} both take lock ${lock}`).toBeUndefined();
        taken.set(lock, file);
      }
    }
    expect(taken.size).toBe(3 * files.length);
  });

  it("the fixture host takes the running file's own locks", () => {
    const options = fixtureOptions({} as StorageAdapter).options;
    expect(options.locks).toEqual(locksOf('locks.test.ts'));
    expect(options.locks).toEqual(ownLocks());
    expect(options.locks).not.toEqual(locksOf('sweep.test.ts'));
  });
});
