import { describe, expect, it } from 'vitest';

import {
  ImportBudget,
  ImportLimitError,
  type ImportLimits,
} from '../../src/import/limits.js';
import {
  ImportPathError,
  relativeParts,
  safeComponent,
} from '../../src/import/paths.js';

const limits: ImportLimits = {
  maxFileBytes: 4,
  maxRunBytes: 7,
  maxFiles: 2,
  maxDirectories: 2,
  maxDepth: 1,
};

/** The code of the refusal `run` throws; any other error, or none, fails the test. */
function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportLimitError || error instanceof ImportPathError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected_refusal');
}

describe('relative import paths', () => {
  it('preserves Unicode, spaces and literal percent sequences', () => {
    expect(relativeParts('Research/日本語/e\u0301.txt')).toEqual([
      'Research', '日本語', 'e\u0301.txt',
    ]);
    expect(safeComponent(' notes .md ')).toBe(' notes .md ');
    expect(safeComponent('%2F.txt')).toBe('%2F.txt');
    expect(Object.isFrozen(relativeParts('a/b.txt'))).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', '\u0000', 'C:notes', 'z:'])(
    'refuses an unsafe component without printing it: %j', (value) => {
      expect(errorCode(() => safeComponent(value))).toBe('unsafe_path');
      expect(() => safeComponent(value)).toThrow('unsafe_path');
    },
  );

  it.each(['/a', 'a/', 'a//b', './a', 'a/../b', 'C:/a', '\\host\\a'])(
    'refuses an unsafe relative path: %j', (value) => {
      expect(errorCode(() => relativeParts(value))).toBe('unsafe_path');
    },
  );

  it('keeps poison names out of the error', () => {
    try {
      relativeParts('../private-poison-file.txt');
      throw new Error('expected_refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportPathError);
      expect((error as Error).message).toBe('unsafe_path');
    }
  });
});

describe('discovery budgets', () => {
  it('accepts exact run, file, directory and depth bounds', () => {
    const budget = new ImportBudget(limits);
    budget.addDirectory(0);
    budget.addDirectory(1);
    expect(budget.addFile(4, 1)).toBe('ready');
    expect(budget.addFile(3, 0)).toBe('ready');
    expect(budget.snapshot()).toEqual({ files: 2, bytes: 7, directories: 2 });
  });

  it('counts an oversized skipped file in both run totals', () => {
    const budget = new ImportBudget(limits);
    expect(budget.addFile(5, 0)).toBe('too_large');
    expect(budget.addFile(2, 0)).toBe('ready');
    expect(budget.snapshot()).toEqual({ files: 2, bytes: 7, directories: 0 });
  });

  it('refuses the first extra file without mutating accepted counts', () => {
    const budget = new ImportBudget(limits);
    budget.addFile(0, 0);
    budget.addFile(0, 0);
    expect(errorCode(() => budget.addFile(0, 0))).toBe('files_limit');
    expect(budget.snapshot()).toEqual({ files: 2, bytes: 0, directories: 0 });
  });

  it('refuses one byte over the run bound without overflow', () => {
    const budget = new ImportBudget(limits);
    budget.addFile(4, 0);
    expect(errorCode(() => budget.addFile(4, 0))).toBe('bytes_limit');
    expect(budget.snapshot()).toEqual({ files: 1, bytes: 4, directories: 0 });
    const large = new ImportBudget({ ...limits, maxRunBytes: Number.MAX_SAFE_INTEGER });
    expect(large.addFile(Number.MAX_SAFE_INTEGER, 0)).toBe('too_large');
    expect(errorCode(() => large.addFile(1, 0))).toBe('bytes_limit');
  });

  it('bounds empty directory traversal and levels below the root', () => {
    const budget = new ImportBudget(limits);
    budget.addDirectory(0);
    budget.addDirectory(1);
    expect(errorCode(() => budget.addDirectory(1))).toBe('directories_limit');
    expect(errorCode(() => new ImportBudget(limits).addDirectory(2))).toBe('depth_limit');
    expect(errorCode(() => new ImportBudget(limits).addFile(1, 2))).toBe('depth_limit');
    expect(budget.snapshot()).toEqual({ files: 0, bytes: 0, directories: 2 });
  });

  it('treats a zero limit as no admission, while depth zero still admits the root level', () => {
    const rootOnly = new ImportBudget({ ...limits, maxDepth: 0 });
    rootOnly.addDirectory(0);
    expect(rootOnly.addFile(1, 0)).toBe('ready');
    expect(errorCode(() => rootOnly.addDirectory(1))).toBe('depth_limit');
    expect(errorCode(() => rootOnly.addFile(1, 1))).toBe('depth_limit');
    expect(rootOnly.snapshot()).toEqual({ files: 1, bytes: 1, directories: 1 });

    expect(errorCode(() => new ImportBudget({ ...limits, maxDirectories: 0 }).addDirectory(0)))
      .toBe('directories_limit');
    expect(errorCode(() => new ImportBudget({ ...limits, maxFiles: 0 }).addFile(0, 0)))
      .toBe('files_limit');

    const noBytes = new ImportBudget({ ...limits, maxRunBytes: 0 });
    expect(noBytes.addFile(0, 0)).toBe('ready');
    expect(errorCode(() => noBytes.addFile(1, 0))).toBe('bytes_limit');
    expect(noBytes.snapshot()).toEqual({ files: 1, bytes: 0, directories: 0 });

    const noFileBytes = new ImportBudget({ ...limits, maxFileBytes: 0 });
    expect(noFileBytes.addFile(0, 0)).toBe('ready');
    expect(noFileBytes.addFile(1, 0)).toBe('too_large');
    expect(noFileBytes.snapshot()).toEqual({ files: 2, bytes: 1, directories: 0 });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe byte and depth metadata: %s', (value) => {
      const budget = new ImportBudget(limits);
      expect(errorCode(() => budget.addFile(value, 0))).toBe('invalid_metadata');
      expect(errorCode(() => budget.addDirectory(value))).toBe('invalid_metadata');
      expect(budget.snapshot()).toEqual({ files: 0, bytes: 0, directories: 0 });
    },
  );

  it('validates all configured limits and copies the configuration', () => {
    for (const key of Object.keys(limits) as Array<keyof ImportLimits>) {
      expect(errorCode(() => new ImportBudget({ ...limits, [key]: -1 })))
        .toBe('invalid_limits');
    }
    const mutable = { ...limits };
    const budget = new ImportBudget(mutable);
    mutable.maxFiles = 100;
    budget.addFile(0, 0);
    budget.addFile(0, 0);
    expect(errorCode(() => budget.addFile(0, 0))).toBe('files_limit');
    expect(new ImportBudget({ ...limits, maxFiles: 0 }).snapshot().files).toBe(0);
  });

  it('returns a detached count snapshot', () => {
    const budget = new ImportBudget(limits);
    const before = budget.snapshot();
    budget.addFile(1, 0);
    expect(before).toEqual({ files: 0, bytes: 0, directories: 0 });
    expect(budget.snapshot()).toEqual({ files: 1, bytes: 1, directories: 0 });
  });
});
