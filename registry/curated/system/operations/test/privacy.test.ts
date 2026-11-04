import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lifecycle, lifecycleFields, mergeFields, outboxRow } from '../src/events/index.js';
import { createOperations } from '../src/index.js';
import { migrateOperations, operationsTables } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, FIXTURE_PLANS, fixtureOptions } from './helpers/host.js';

const ADDRESS = 'dana.reyes@example.invalid';
const SENTENCE = 'my card was charged twice for the same meeting';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkYW5hIn0.k3Jv0Yb8iGVq6Q9Wn1tq0bq4n5Q1o8m7X2c3d4e5f6g';
const SIGN_IN_LINK = 'https://app.example.invalid/sign-in?token=6f1c0e2b9a8d7c6b5a4f3e2d1c0b9a8f';
const SIGN_IN_PATH = '/sign-in/6f1c0e2b9a8d7c6b5a4f3e2d1c0b9a8f';
const ERROR_SENTENCE = new TypeError('the call with Dana about the Harbour merger could not be saved').message;

const FIXTURES = [ADDRESS, SENTENCE, TOKEN, SIGN_IN_LINK, SIGN_IN_PATH, ERROR_SENTENCE] as const;

/** The tables that may name a person (D40): the support tables. Every other table is scanned. */
const SUPPORT_TABLES = new Set(['tickets', 'messages', 'attachments']);

describeBackends('privacy', (backend) => {
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

  it("an address, a sentence, a token, a sign-in link and a TypeError carrying a sentence, fed through every entry this release builds, appear in no table outside the support tables and in none of the package's own lines", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);

    for (const value of FIXTURES) {
      const loose = value as never;
      ops.lines.push({ process: 'web', kind: value });
      ops.lines.push({ process: value, kind: 'request' });
      ops.lines.push({ process: 'web', kind: 'request', path: value });
      ops.lines.push({ process: 'web', kind: 'request', status: loose });
      ops.lines.push({ process: 'web', kind: 'request', fields: { kind: value } });
      ops.lines.push({ process: 'web', kind: 'request', fields: { session: value } });
      ops.lines.push({ process: 'web', kind: 'request', fields: { path: value } });
      ops.lines.push({ process: 'web', kind: 'request', fields: { ms: loose } });
      ops.lines.push({ process: 'web', kind: 'request', fields: { [value]: 1 } });
      ops.events.record(value);
      ops.events.record('search', { plan: value });
      ops.events.record('search', { n: loose });
      ops.events.record('search', { fields: { kind: value } });
      ops.events.record('search', { fields: { session: value } });
      ops.events.record('search', { fields: { [value]: 1 } });
    }
    // What the rule admits still lands, so the scan below reads tables that hold rows.
    ops.lines.push({ process: 'web', kind: 'request', status: 200, path: '/api/sessions/[id]', fields: { ms: 12 } });
    ops.events.record('search', { plan: 'free', fields: { ms: 3 } });
    await ops.stop();

    let scanned = 0;
    for (const table of operationsTables(prefix)) {
      if (SUPPORT_TABLES.has(table.slice(prefix.length + 1))) continue;
      // The one package table that holds a product's ids, on the product's side: the case below holds that none of them crosses.
      if (table === `${prefix}_lifecycle_outbox`) continue;
      const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      scanned += rows.length;
      const text = JSON.stringify(rows);
      for (const value of FIXTURES) expect(text, `${table} holds a fixture`).not.toContain(value);
    }
    expect(scanned).toBeGreaterThanOrEqual(2);
    expect(await db.all(`SELECT id FROM ${prefix}_log_lines WHERE path = '/api/sessions/[id]'`)).toHaveLength(1);
    expect(await db.all(`SELECT id FROM ${prefix}_events WHERE plan = 'free'`)).toHaveLength(1);

    const logged = JSON.stringify(fixture.recorder.lines);
    for (const value of FIXTURES) expect(logged).not.toContain(value);
    expect(fixture.recorder.linesOf('ops_refused').length).toBeGreaterThan(0);
  });

  it("a row's fact stays on the product's side: delivered, it reaches neither the events table nor the package's own lines", async () => {
    const clock = fakeClock();
    const fixture = fixtureOptions(db, { prefix, fields: mergeFields(lifecycleFields(FIXTURE_PLANS), FIXTURE_FIELDS) }, clock);
    const ops = createOperations(fixture.options);
    const cast = backend.name === 'postgres' ? 'CAST(? AS jsonb)' : '?';
    for (const value of FIXTURES) {
      const row = outboxRow(lifecycle.refund({ plan: 'plus', amountMicro: 9_000_000, of: 'subscription', by: 'dashboard' }), { fact: value, prefix, now: clock.now });
      await db.run(`INSERT INTO ${row.table} (id, fact, kind, plan, n, fields, created) VALUES (?, ?, ?, ?, ?, ${cast}, ?)`, [row.id, row.fact, row.kind, row.plan, row.n, row.fields, row.created]);
    }
    // The row is written old, so the drain writes its ops_lifecycle line, and the line is read for the fact too.
    clock.advance(11 * 60_000);
    expect(await ops.events.drainLifecycle()).toMatchObject({ delivered: FIXTURES.length, refused: 0, pending: 0 });
    await ops.stop();

    const stored = JSON.stringify(await db.all(`SELECT * FROM ${prefix}_events WHERE kind = 'refund'`));
    const logged = JSON.stringify(fixture.recorder.lines);
    expect(fixture.recorder.linesOf('ops_lifecycle')).toHaveLength(1);
    for (const value of FIXTURES) {
      expect(stored).not.toContain(value);
      expect(logged).not.toContain(value);
    }
  });
});
