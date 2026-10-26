import { createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installReporter, reportError } from '../src/browser/index.js';
import { runOpsCheck } from '../src/check/index.js';
import { createErrors } from '../src/errors/index.js';
import { createHealth } from '../src/health/index.js';
import { createHandlers } from '../src/http/index.js';
import { createOperations } from '../src/index.js';
import { OpsNotBuilt } from '../src/not-built.js';
import { createRemote } from '../src/remote/index.js';
import { createEdgeWatcher } from '../src/worker/index.js';
import { fixtureOptions } from './helpers/host.js';

/** What a call throws, or undefined when it returns. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A surface of the next minor release says so, and names no task of the plan that builds it. */
function expectNextMinor(error: unknown, surface: string): void {
  expect(error).toBeInstanceOf(OpsNotBuilt);
  const notBuilt = error as OpsNotBuilt;
  expect(notBuilt.code).toBe('not_built');
  expect(notBuilt.surface).toBe(surface);
  expect(notBuilt.message).toMatch(/^not_built: /);
  expect(notBuilt.message).toContain('next minor release');
  expect(notBuilt.message).not.toMatch(/task/i);
  expect(Object.keys(notBuilt)).not.toContain('task');
}

describe('the surfaces of the next minor release', () => {
  it('each entry imports, and its factory throws not_built at the call, naming the next minor release and no task', () => {
    const entries: ReadonlyArray<readonly [string, () => unknown]> = [
      ['errors', createErrors],
      ['health', createHealth],
      ['http', createHandlers],
      ['remote', createRemote],
      ['browser.installReporter', installReporter],
      ['browser.reportError', reportError],
      ['worker', createEdgeWatcher],
      ['check', runOpsCheck],
    ];
    for (const [surface, factory] of entries) expectNextMinor(thrownBy(factory), surface);
  });
});

describe('createOperations before the next minor release', () => {
  let db: StorageAdapter;

  beforeAll(async () => {
    db = createSqlJsAdapter();
    await db.open();
  });

  afterAll(async () => {
    await db.close();
  });

  it('answers errors and health whose calls throw not_built naming the next minor release, while tickets and the account functions are built', async () => {
    const operations = createOperations(fixtureOptions(db).options);
    expectNextMinor(thrownBy(() => operations.errors.groups()), 'errors.groups');
    expectNextMinor(thrownBy(() => operations.health.status()), 'health.status');
    expect(await operations.tickets?.stats({ accountId: 'staff-1', role: 'owner' })).toMatchObject({ open: 0, waiting: 0, urgent: 0, resolvedToday: 0 });
    await operations.stop();
  });

  it('answers every member of errors and health with not_built, health.queue among them', async () => {
    const operations = createOperations(fixtureOptions(db).options);
    const members: Readonly<Record<'errors' | 'health', readonly string[]>> = {
      errors: ['capture', 'report', 'groups', 'group', 'setState'],
      health: ['check', 'queue', 'beat', 'box', 'outage', 'status'],
    };
    for (const [surface, names] of Object.entries(members)) {
      const object = operations[surface as keyof typeof members] as unknown as Record<string, () => unknown>;
      // A member the stub lacks is not a function, so calling it throws a TypeError, never not_built.
      for (const name of names) expectNextMinor(thrownBy(() => object[name]()), `${surface}.${name}`);
    }
    await operations.stop();
  });
});
