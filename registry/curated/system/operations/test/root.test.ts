import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOperations, migrateOperations } from '../src/index.js';
import { OpsNotBuilt } from '../src/not-built.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const STAFF = { accountId: 'staff-1', role: 'owner' };

describeBackends('the root entry', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('through the root entry, createOperations(...).lines.push and .events.record land their rows while errors, health and tickets answer not_built at the call', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 22, 15, 30));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    ops.lines.push({ process: 'web', kind: 'request', status: 200, path: '/api/v1/notes', fields: { ms: 5 } });
    ops.events.record('search', { plan: 'free' });
    expect(() => ops.errors.capture(new Error('a fault'))).toThrow(OpsNotBuilt);
    expect(() => ops.health.status()).toThrow(OpsNotBuilt);
    expect(() => ops.tickets?.stats(STAFF)).toThrow(OpsNotBuilt);
    await ops.stop();

    const lines = await db.all<{ kind: string; status: number | string; path: string }>(`SELECT kind, status, path FROM ${prefix}_log_lines`);
    expect(lines.map((line) => [line.kind, Number(line.status), line.path])).toEqual([['request', 200, '/api/v1/notes']]);
    const events = await db.all<{ kind: string; plan: string; at: number | string }>(`SELECT kind, plan, at FROM ${prefix}_events`);
    expect(events.map((event) => [event.kind, event.plan, Number(event.at)])).toEqual([['search', 'free', Date.UTC(2026, 9, 22, 15)]]);
    expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);
    expect(fixture.recorder.linesOf('ops_flush')).toEqual([]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('a fault');
  });
});
