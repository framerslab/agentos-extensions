import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { describe, expect, it } from 'vitest';
import type { OpsOptions } from '../src/contract.js';
import { createOperations } from '../src/index.js';
import { fixtureOptions } from './helpers/host.js';

/** An adapter that counts the statements it is asked for and runs none, so a refusal is shown to come before any. */
function countingDb() {
  let statements = 0;
  const touch = async () => {
    statements += 1;
    throw new Error('a statement ran');
  };
  const db = { kind: 'sqljs', run: touch, get: touch, all: touch, exec: touch, transaction: touch, batch: touch } as unknown as StorageAdapter;
  return { db, statements: () => statements };
}

describe('createOperations checks its options before any statement', () => {
  it('refuses a prefix outside the rule, a logger without warn, locks that are not three distinct integers, an empty fields rule, categories outside 2 to 12 words and an audit hook that is not a function', () => {
    const { db, statements } = countingDb();
    const base = fixtureOptions(db).options;
    const tickets = base.tickets!;
    const thirteen = Array.from({ length: 13 }, (_, index) => `category_${index}`);
    const refused: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp | typeof RangeError]> = [
      ['a prefix with a capital', { prefix: 'Ops' }, RangeError],
      ['a prefix that starts with a digit', { prefix: '1ops' }, RangeError],
      ['a logger without warn', { logger: { info() {}, error() {} } }, /logger/],
      ['two locks', { locks: [1, 2] }, /locks/],
      ['a repeated lock', { locks: [1, 1, 2] }, /locks/],
      ['a lock that is not an integer', { locks: [1, 2, 2.5] }, /locks/],
      ['an empty fields rule', { fields: {} }, /fields/],
      ['one category', { tickets: { ...tickets, categories: ['billing'] } }, /categories/],
      ['thirteen categories', { tickets: { ...tickets, categories: thirteen } }, /categories/],
      ['an audit hook that is not a function', { audit: 'not a function' }, /audit/],
    ];
    for (const [what, override, error] of refused) {
      const options = { ...base, ...override } as unknown as OpsOptions;
      const thrown = (() => {
        try {
          createOperations(options);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      if (error === RangeError) expect({ what, refused: thrown instanceof RangeError }).toEqual({ what, refused: true });
      else expect({ what, message: thrown instanceof TypeError ? thrown.message : String(thrown) }).toEqual({ what, message: expect.stringMatching(error as RegExp) });
    }
    expect(statements()).toBe(0);
  });

  it('refuses all among the plan words, the word the totals give the sum over the plans, before any statement', () => {
    const { db, statements } = countingDb();
    const base = fixtureOptions(db).options;
    expect(() => createOperations({ ...base, metrics: { ...base.metrics!, plans: ['free', 'all'] } })).toThrow(/metrics\.plans.*\ball\b/);
    expect(statements()).toBe(0);
  });

  it('on SQLite, refuses sqlite and a prefix beginning sqlite_ with a RangeError before any statement', () => {
    const { db, statements } = countingDb();
    const base = fixtureOptions(db).options;
    for (const prefix of ['sqlite', 'sqlite_ops']) expect(() => createOperations({ ...base, prefix })).toThrow(RangeError);
    expect(statements()).toBe(0);
  });

  it('keeps the fixture host with an audit hook for error triage, and runs no statement at creation', () => {
    const { db, statements } = countingDb();
    const audits: unknown[] = [];
    const options: OpsOptions = { ...fixtureOptions(db).options, audit: async (_trx, entry) => void audits.push(entry) };
    const operations = createOperations(options);
    expect(typeof operations.start).toBe('function');
    expect(operations.tickets).not.toBeNull();
    expect(statements()).toBe(0);
  });
  it("refuses a pictureOutputBytesMax above 1,048,576, the bytes the attachments table takes for one picture (both schemas' CHECK), before any statement, and keeps one at the bound", () => {
    const { db, statements } = countingDb();
    const base = fixtureOptions(db).options;
    expect(() => createOperations({ ...base, limits: { pictureOutputBytesMax: 1_048_577 } })).toThrow(/pictureOutputBytesMax.*1048576/);
    expect(createOperations({ ...base, limits: { pictureOutputBytesMax: 1_048_576 } }).tickets).not.toBeNull();
    expect(statements()).toBe(0);
  });
});
