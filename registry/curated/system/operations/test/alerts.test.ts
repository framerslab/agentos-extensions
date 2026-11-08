import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  ALERT_GIVE_UP_MS,
  ALERT_HOOK_TIMEOUT_MS,
  ALERT_MAIL_KEY,
  ALERT_PENDING_MAX,
  alertBackoffMs,
  createAlerts,
} from '../src/alerts/outbox.js';
import { createContext } from '../src/context.js';
import type { Operations, OpsDiscordAnswer, OpsDiscordPost, OpsMail, OpsOptions } from '../src/contract.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { describeBackends, dropOperationsTables, freshPrefix, type Backend } from './helpers/adapters.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';
import { fixtureOptions, type Fixture } from './helpers/host.js';

const NOW = Date.UTC(2026, 10, 9, 9, 0, 0);
const NOTHING = { sent: 0, retried: 0, failed: 0, dropped: 0 };
const POST: OpsDiscordPost = { source: 'ticket_routing', channel: 'requests', dedupKey: 'ticket_waiting:P-1:24', lines: ['a', 'b'] };

/** The four lines `ticket_routing` posts for a request past its bound: its anonymous id, its state and category, a count and a link behind the sign-in. */
const ROUTING_LINES = [
  'Request P-7KQ2XM is waiting on the team.',
  'State: waiting_team. Category: billing. Waiting 26 hours.',
  '3 requests are waiting on the team.',
  'https://example.invalid/admin/support/P-7KQ2XM',
];

/** The four lines a failed job posts. */
const FAILED_LINES = ['Job nightly_backup failed.', 'Failed 5 of 5 tries.', 'Paused until someone resumes it.', 'https://example.invalid/admin/jobs/nightly_backup'];

type Answer = OpsDiscordAnswer | ((signal: AbortSignal) => Promise<OpsDiscordAnswer>);

/** A `discord` hook that records each call and answers from a list the test fills (`sent` with `m1` when it is empty). */
function recordingHook() {
  const calls: Array<{ post: OpsDiscordPost; signal: AbortSignal }> = [];
  const answers: Answer[] = [];
  const hook = async (post: OpsDiscordPost, _db: StorageAdapter, signal: AbortSignal): Promise<OpsDiscordAnswer> => {
    calls.push({ post, signal });
    const next = answers.shift();
    if (next === undefined) return { outcome: 'sent', deliveryId: 'm1' };
    return typeof next === 'function' ? next(signal) : next;
  };
  return { calls, answers, hook };
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The stored row of `dedupKey` with its times as numbers, or null. */
async function stored(db: StorageAdapter, prefix: string, dedupKey: string) {
  const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${prefix}_discord_outbox WHERE dedup_key = ?`, [dedupKey]);
  if (!row) return null;
  return {
    source: row.source,
    channel: row.channel,
    content: row.content,
    state: row.state,
    attempts: numberOrNull(row.attempts),
    firstAttemptAt: numberOrNull(row.first_attempt_at),
    nextAt: numberOrNull(row.next_at),
    deliveredAt: numberOrNull(row.delivered_at),
    deliveryId: row.delivery_id,
    lastAnswer: row.last_answer,
    mailState: row.mail_state,
    mailAttempts: numberOrNull(row.mail_attempts),
    settledAt: numberOrNull(row.settled_at),
  };
}

const countRows = async (db: StorageAdapter, prefix: string, where = '1 = 1'): Promise<number> =>
  Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${prefix}_discord_outbox WHERE ${where}`))?.n ?? -1);

type Method = 'run' | 'get' | 'all' | 'exec';

interface Watch {
  /** Called with each statement before it runs. */
  seen?(sql: string, method: Method): void;
  /** Called once a statement has run: a promise it answers holds the statement's answer until it settles. */
  hold?(sql: string, method: Method): Promise<void> | undefined;
}

/** `db` with each statement it runs, inside its transactions too, shown to `watch` (a second object, so on SQLite a set of its own). */
function watched(db: StorageAdapter, watch: Watch): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'run' || property === 'get' || property === 'all' || property === 'exec') {
          const method: Method = property;
          return async (sql: string, parameters?: unknown) => {
            watch.seen?.(sql, method);
            const call = Reflect.get(object, method, object) as (sql: string, parameters?: unknown) => Promise<unknown>;
            const answer = await (method === 'exec' ? call.call(object, sql) : call.call(object, sql, parameters));
            await watch.hold?.(sql, method);
            return answer;
          };
        }
        if (property === 'transaction') {
          return (work: (trx: StorageAdapter) => Promise<unknown>, options?: unknown) => object.transaction((trx) => work(wrap(trx)), options as never);
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

/**
 * A one-time hold on the first statement `matches` picks once armed (at once unless `armed` is false, then from `arm()`): `reached`
 * settles when it has run, and its answer waits for `release`.
 */
function holdOnce(matches: (sql: string, method: Method) => boolean, { armed: armedAtStart = true }: { armed?: boolean } = {}) {
  const reached = deferred<void>();
  const gate = deferred<void>();
  let armed = armedAtStart;
  return {
    reached: reached.promise,
    arm: () => {
      armed = true;
    },
    release: () => gate.resolve(),
    hold(sql: string, method: Method): Promise<void> | undefined {
      if (!armed || !matches(sql, method)) return undefined;
      armed = false;
      reached.resolve();
      return gate.promise;
    },
  };
}

/** The drain's read of its due rows (on PostgreSQL inside the claim's transaction). */
const isDueRead = (sql: string): boolean => sql.includes('next_at <= ?');

describeBackends('the Discord outbox', (backend: Backend) => {
  let db: StorageAdapter;

  beforeAll(async () => {
    db = await backend.open();
  });

  afterAll(async () => {
    await db.close();
  });

  interface Scope {
    readonly prefix: string;
    readonly clock: FakeClock;
    /** Operations over `on` (the test's adapter by default) under the scope's prefix and clock, stopped when the scope ends. */
    build(overrides?: Partial<OpsOptions>, on?: StorageAdapter): { ops: Operations; fixture: Fixture };
    /**
     * A second process's adapter: on PostgreSQL a second pool, closed when the scope ends; on SQLite the same adapter, since
     * SQLite is one process by the adapter's design and a second `createOperations` over it is what a second drain there is.
     */
    second(): Promise<StorageAdapter>;
  }

  /** Runs `body` over tables of its own, dropped at the end, every operations it built stopped first. */
  async function within(body: (scope: Scope) => Promise<void>): Promise<void> {
    const prefix = freshPrefix();
    await migrateOperations(db, { prefix });
    const built: Operations[] = [];
    const others: StorageAdapter[] = [];
    const clock = fakeClock(NOW);
    const scope: Scope = {
      prefix,
      clock,
      build(overrides = {}, on = db) {
        const fixture = fixtureOptions(on, { prefix, ...overrides }, clock);
        const ops = createOperations(fixture.options);
        built.push(ops);
        return { ops, fixture };
      },
      async second() {
        if (backend.name !== 'postgres') return db;
        const other = await backend.open();
        others.push(other);
        return other;
      },
    };
    try {
      await body(scope);
    } finally {
      for (const ops of built) await ops.stop();
      for (const other of others) await other.close();
      await dropOperationsTables(db, prefix);
    }
  }

  it('1. a post whose dedup key is held writes nothing and answers null; two drains at once, in two operations over the one database, deliver the row once', async () => {
    await within(async ({ prefix, clock, build, second }) => {
      const hook = recordingHook();
      const a = build({ discord: hook.hook });
      const b = build({ discord: hook.hook }, await second());

      const first = await a.ops.alerts.post(POST);
      expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
      expect(await a.ops.alerts.post(POST)).toBeNull();
      expect(await b.ops.alerts.post({ ...POST, lines: ['other words'] })).toBeNull();
      expect(await countRows(db, prefix)).toBe(1);

      const [one, two] = await Promise.all([a.ops.alerts.sendDue(clock.now()), b.ops.alerts.sendDue(clock.now())]);
      expect(hook.calls).toHaveLength(1);
      expect(hook.calls[0]?.post).toEqual(POST);
      expect(one.sent + two.sent).toBe(1);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({
        state: 'delivered',
        attempts: 1,
        firstAttemptAt: NOW,
        deliveredAt: NOW,
        deliveryId: 'm1',
        lastAnswer: '200',
        mailState: 'none',
        settledAt: NOW,
        content: 'a\nb',
      });
      const sent = [...a.fixture.recorder.linesOf('delivery_sent'), ...b.fixture.recorder.linesOf('delivery_sent')];
      expect(sent).toEqual([{ level: 'info', message: 'delivery_sent', fields: { channel: 'requests' } }]);

      // A delivered row is never tried again.
      clock.advance(3_600_000);
      expect(await a.ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
    });
  });

  it("2. a retry's wait, an unconfirmed post and a failed status each leave the row pending with the attempt counted and the next try set; a drain before it touches the row not", async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops, fixture } = build({ discord: hook.hook });
      await ops.alerts.post(POST);

      hook.answers.push({ outcome: 'retry', afterMs: 30_000, status: 429 });
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 1, lastAnswer: '429', nextAt: NOW + 30_000, firstAttemptAt: NOW, settledAt: null });

      clock.advance(29_999);
      expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);

      clock.advance(1);
      hook.answers.push({ outcome: 'failed', status: 500 });
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({
        state: 'pending',
        attempts: 2,
        lastAnswer: '500',
        nextAt: clock.now() + alertBackoffMs(2),
        firstAttemptAt: NOW,
      });

      clock.set(NOW + 30_000 + alertBackoffMs(2));
      hook.answers.push({ outcome: 'retry', afterMs: 5_000, status: 200 });
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 3, lastAnswer: 'unconfirmed', nextAt: clock.now() + 5_000 });

      expect(fixture.recorder.linesOf('delivery_retry')).toEqual([
        { level: 'info', message: 'delivery_retry', fields: { channel: 'requests', answer: 'rate_limited', status: 429, wait_s: 30 } },
        { level: 'info', message: 'delivery_retry', fields: { channel: 'requests', answer: 'status', status: 500, wait_s: 10 } },
        { level: 'info', message: 'delivery_retry', fields: { channel: 'requests', answer: 'unconfirmed', status: 200, wait_s: 5 } },
      ]);
      // The backoff: 5 s doubling to 10 minutes.
      expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(alertBackoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000]);
    });
  });

  it('3. 24 hours after the first try the row gives up into one team mail with its lines as records, the hook never called again; a mail that fails twice, or one suppressed, leaves the mail failed with one line', async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops, fixture } = build({ discord: hook.hook });
      await ops.alerts.post(POST);
      hook.answers.push({ outcome: 'failed', status: 503 });
      await ops.alerts.sendDue(clock.now());

      clock.set(NOW + ALERT_GIVE_UP_MS);
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, failed: 1 });
      expect(hook.calls).toHaveLength(1);
      expect(fixture.recorder.mails).toEqual([
        { kind: 'teamAlert', to: 'team@example.invalid', key: ALERT_MAIL_KEY, lines: [{ line: 'a' }, { line: 'b' }], idempotencyKey: POST.dedupKey },
      ]);
      expect(ALERT_MAIL_KEY).toBe('discord_undelivered');
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'failed', lastAnswer: 'gave_up', mailState: 'sent', mailAttempts: 1, settledAt: NOW + ALERT_GIVE_UP_MS });
      clock.advance(3_600_000);
      expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
      expect(fixture.recorder.mails).toHaveLength(1);
      expect(fixture.recorder.linesOf('delivery_failed')).toEqual([]);
    });

    for (const [what, answers, word] of [
      ['a mail that fails twice', ['failed', 'failed'], 'mail_failed'],
      ['a mail that throws, then fails', ['throws', 'failed'], 'mail_failed'],
      ['a suppressed mail', ['suppressed'], 'suppressed'],
    ] as const) {
      await within(async ({ prefix, clock, build }) => {
        const hook = recordingHook();
        const mails: OpsMail[] = [];
        const left = [...answers];
        const { ops, fixture } = build({
          discord: hook.hook,
          async mail(message) {
            mails.push(message);
            const next = left.shift() ?? 'sent';
            if (next === 'throws') throw new Error('the sender broke');
            return next;
          },
        });
        await ops.alerts.post(POST);
        hook.answers.push({ outcome: 'retry', afterMs: 1_000, status: 429 });
        await ops.alerts.sendDue(clock.now());

        clock.set(NOW + ALERT_GIVE_UP_MS);
        await ops.alerts.sendDue(clock.now());
        if (answers.length === 2) {
          // The first failure leaves the mail owed, tried again a minute later, and no line yet.
          expect({ what, row: await stored(db, prefix, POST.dedupKey) }).toMatchObject({ what, row: { state: 'failed', mailState: 'owed', mailAttempts: 1, settledAt: null } });
          expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
          expect(mails).toHaveLength(1);
          clock.advance(60_000);
          await ops.alerts.sendDue(clock.now());
        }
        expect({ what, row: await stored(db, prefix, POST.dedupKey) }).toMatchObject({
          what,
          row: { state: 'failed', lastAnswer: 'gave_up', mailState: 'failed', mailAttempts: answers.length, settledAt: clock.now() },
        });
        expect(mails).toHaveLength(answers.length);
        expect(hook.calls).toHaveLength(1);
        expect({ what, lines: fixture.recorder.linesOf('delivery_failed') }).toEqual({
          what,
          lines: [{ level: 'warn', message: 'delivery_failed', fields: { channel: 'requests', answer: word } }],
        });
        clock.advance(3_600_000);
        expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
        expect(mails).toHaveLength(answers.length);
      });
    }
  });

  it('4a. a hook that is slow holds its row: a second drain in another operations skips it and answers at once, and the row is written from the hook\'s answer once', async () => {
    await within(async ({ prefix, clock, build, second }) => {
      const hook = recordingHook();
      const a = build({ discord: hook.hook });
      const b = build({ discord: hook.hook }, await second());
      await a.ops.alerts.post(POST);
      const held = deferred<OpsDiscordAnswer>();
      hook.answers.push(() => held.promise);

      const first = a.ops.alerts.sendDue(clock.now());
      await vi.waitFor(() => expect(hook.calls).toHaveLength(1));
      expect(await b.ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);

      held.resolve({ outcome: 'sent', deliveryId: 'm2' });
      expect(await first).toEqual({ ...NOTHING, sent: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'm2', attempts: 1 });
      expect(await b.ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
    });
  });

  it("4b. a hook that ignores its signal keeps its row past the deadline: the drain is still waiting, a second drain past the persisted claim skips the row, and the hook's late answer is written once", async () => {
    await within(async ({ prefix, clock, second }) => {
      expect(ALERT_HOOK_TIMEOUT_MS).toBe(6_000);
      const hook = recordingHook();
      const timeout = 100;
      const a = createAlerts(createContext(fixtureOptions(db, { prefix, discord: hook.hook }, clock).options), { hookTimeoutMs: timeout });
      const b = createAlerts(createContext(fixtureOptions(await second(), { prefix, discord: hook.hook }, clock).options), { hookTimeoutMs: timeout });
      await a.post(POST);
      const held = deferred<OpsDiscordAnswer>();
      hook.answers.push(() => held.promise);

      let settled = false;
      const first = a.sendDue(clock.now()).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(hook.calls).toHaveLength(1));
      await sleep(timeout * 3);
      expect(hook.calls[0]?.signal.aborted).toBe(true);
      expect(settled).toBe(false);

      // Past the claim's persisted deadline (the timeout and a second): the row reads as due, and is still the first drain's.
      clock.set(NOW + timeout + 1_000 + 900);
      expect(await b.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);

      held.resolve({ outcome: 'sent', deliveryId: 'late' });
      expect(await first).toEqual({ ...NOTHING, sent: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'late', attempts: 1 });
      clock.advance(60_000);
      expect(await b.sendDue(clock.now())).toEqual(NOTHING);
      expect(await a.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
    });
  });

  it('4c. a hook that honours its signal settles at the deadline, and the row is tried again with no_answer', async () => {
    await within(async ({ prefix, clock }) => {
      const hook = recordingHook();
      const fixture = fixtureOptions(db, { prefix, discord: hook.hook }, clock);
      const alerts = createAlerts(createContext(fixture.options), { hookTimeoutMs: 100 });
      await alerts.post(POST);
      hook.answers.push(
        (signal) =>
          new Promise<OpsDiscordAnswer>((resolve) => {
            signal.addEventListener('abort', () => resolve({ outcome: 'failed', status: null }), { once: true });
          }),
      );
      const began = Date.now();
      expect(await alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(hook.calls[0]?.signal.aborted).toBe(true);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 1, lastAnswer: 'no_answer', nextAt: NOW + alertBackoffMs(1) });
      expect(fixture.recorder.linesOf('delivery_retry')).toEqual([
        { level: 'info', message: 'delivery_retry', fields: { channel: 'requests', answer: 'no_answer', wait_s: 5 } },
      ]);
    });
  });

  it('5. a channel holds 50 pending rows: the post past them drops the oldest with one ops_discord line, another channel keeps its own, and a drain drops what stands past the bound', async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops, fixture } = build({ discord: hook.hook });
      expect(ALERT_PENDING_MAX).toBe(50);
      await ops.alerts.post({ ...POST, channel: 'alerts', dedupKey: 'job_failed:nightly_backup:1' });
      for (let index = 0; index <= ALERT_PENDING_MAX; index += 1) {
        clock.advance(1);
        await ops.alerts.post({ ...POST, dedupKey: `ticket_waiting:P-${index}:24` });
      }
      expect(await countRows(db, prefix, "channel = 'requests' AND state = 'pending'")).toBe(50);
      expect(await countRows(db, prefix, "channel = 'alerts' AND state = 'pending'")).toBe(1);
      // Dropped by the 51st post, at its time.
      expect(await stored(db, prefix, 'ticket_waiting:P-0:24')).toMatchObject({ state: 'dropped', lastAnswer: 'dropped', settledAt: NOW + ALERT_PENDING_MAX + 1 });
      expect(await stored(db, prefix, 'ticket_waiting:P-1:24')).toMatchObject({ state: 'pending' });
      expect(fixture.recorder.linesOf('ops_discord')).toEqual([{ level: 'warn', message: 'ops_discord', fields: { channel: 'requests', outcome: 'dropped', count: 1 } }]);

      // Two rows written past the bound by another way than post (an older process): the drain drops the oldest two first.
      for (const key of ['ticket_waiting:P-x:24', 'ticket_waiting:P-y:24']) {
        clock.advance(1);
        await db.run(
          `INSERT INTO ${prefix}_discord_outbox (id, source, channel, dedup_key, content, state, attempts, next_at, created) VALUES (?, 'ticket_routing', 'requests', ?, 'a', 'pending', 0, ?, ?)`,
          [`row-${key}`, key, clock.now(), clock.now()],
        );
      }
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ sent: 51, retried: 0, failed: 0, dropped: 2 });
      expect(await stored(db, prefix, 'ticket_waiting:P-1:24')).toMatchObject({ state: 'dropped' });
      expect(await stored(db, prefix, 'ticket_waiting:P-2:24')).toMatchObject({ state: 'dropped' });
      expect(await stored(db, prefix, 'ticket_waiting:P-3:24')).toMatchObject({ state: 'delivered' });
      expect(await stored(db, prefix, 'ticket_waiting:P-y:24')).toMatchObject({ state: 'delivered' });
      expect(fixture.recorder.linesOf('ops_discord').at(-1)).toEqual({ level: 'warn', message: 'ops_discord', fields: { channel: 'requests', outcome: 'dropped', count: 2 } });
      expect(hook.calls).toHaveLength(51);
    });
  });

  it("6. the content guard: ticket_routing's lines and a failed job's lines pass and are stored with no id or address; a line, a key or a source carrying a request's id, a UUID or an address is refused and writes nothing", async () => {
    await within(async ({ prefix, clock, build }) => {
      const { ops } = build({ discord: recordingHook().hook });
      await ops.alerts.post({ source: 'ticket_routing', channel: 'requests', dedupKey: 'ticket_waiting:P-7KQ2XM:24', lines: ROUTING_LINES });
      clock.advance(1);
      await ops.alerts.post({ source: 'nightly_backup', channel: 'alerts', dedupKey: 'job_failed:nightly_backup:1762678800000', lines: FAILED_LINES });
      const rows = await db.all<{ content: string; dedup_key: string; source: string }>(`SELECT content, dedup_key, source FROM ${prefix}_discord_outbox`);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        for (const text of [row.content, row.dedup_key, row.source]) {
          expect(text).not.toMatch(/[0-9a-f]{32}/);
          expect(text).not.toMatch(/\S+@\S+\.\S+/);
        }
      }

      const ticketId = `tkt_${'0123456789abcdef'.repeat(2)}`;
      const refused: ReadonlyArray<readonly [string, OpsDiscordPost]> = [
        ["a request's id in a line", { ...POST, dedupKey: 'k1', lines: [`Request ${ticketId} is waiting.`] }],
        ["a request's id in the key", { ...POST, dedupKey: `ticket_waiting:${ticketId}:24` }],
        ['a UUID in a line', { ...POST, dedupKey: 'k2', lines: ['Account 3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b'] }],
        ['an address in a line', { ...POST, dedupKey: 'k3', lines: ['From dana.reyes@example.com'] }],
        ['an address in the key', { ...POST, dedupKey: 'waiting:dana@example.com' }],
        ['upper-case hexadecimal in a line', { ...POST, dedupKey: 'k4', lines: ['0123456789ABCDEF0123456789ABCDEF'] }],
      ];
      for (const [what, post] of refused) {
        await expect(ops.alerts.post(post), what).rejects.toBeInstanceOf(RangeError);
      }
      // The refusal's message names neither the id nor the address.
      const message = await ops.alerts.post(refused[0]![1]).catch((error: Error) => error.message);
      expect(message).not.toContain(ticketId);
      expect(await countRows(db, prefix)).toBe(2);
    });
  });

  it("7. list answers a job's rows by source whatever their keys, or by a key prefix, newest first; a source is a scheduler name of up to 64 characters and a channel a word", async () => {
    await within(async ({ clock, build }) => {
      const { ops } = build({ discord: recordingHook().hook });
      const at: Record<string, number> = {};
      for (const [source, dedupKey] of [
        ['ticket_routing', 'ticket_waiting:P-1:24'],
        ['nightly_backup', 'job_failed:nightly_backup:1'],
        ['ticket_routing', 'ticket_waiting:P-2:12'],
        ['ticket_routing', 'routing_summary:7'],
      ] as const) {
        clock.advance(1_000);
        at[dedupKey] = clock.now();
        await ops.alerts.post({ source, channel: 'requests', dedupKey, lines: ['a'] });
      }
      const keys = (rows: readonly { dedupKey: string }[]) => rows.map((row) => row.dedupKey);
      expect(keys(await ops.alerts.list({ source: 'ticket_routing' }))).toEqual(['routing_summary:7', 'ticket_waiting:P-2:12', 'ticket_waiting:P-1:24']);
      expect(keys(await ops.alerts.list({ prefix: 'job_failed:' }))).toEqual(['job_failed:nightly_backup:1']);
      expect(keys(await ops.alerts.list({ prefix: 'ticket_waiting:' }, { limit: 1 }))).toEqual(['ticket_waiting:P-2:12']);
      // The prefix is matched as written: an underscore or a percent sign in it matches itself alone.
      expect(await ops.alerts.list({ prefix: 'ticket_waiting_' })).toEqual([]);
      expect(await ops.alerts.list({ prefix: '%' })).toEqual([]);
      expect(await ops.alerts.list({ source: 'no_such_job' })).toEqual([]);

      const [row] = await ops.alerts.list({ source: 'nightly_backup' });
      expect(row).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        source: 'nightly_backup',
        channel: 'requests',
        dedupKey: 'job_failed:nightly_backup:1',
        state: 'pending',
        attempts: 0,
        firstAttemptAt: null,
        nextAt: at['job_failed:nightly_backup:1'],
        deliveredAt: null,
        deliveryId: null,
        mailState: 'none',
        lastAnswer: null,
        createdAt: at['job_failed:nightly_backup:1'],
      });

      const longest = `j${'x'.repeat(63)}`;
      expect(longest).toHaveLength(64);
      expect(await ops.alerts.post({ source: longest, channel: 'alerts', dedupKey: 'long', lines: ['a'] })).toEqual({ id: expect.any(String) });
      const typeErrors: ReadonlyArray<readonly [string, unknown]> = [
        ['a source of 65 characters', { ...POST, source: `${longest}x` }],
        ['a source with a capital', { ...POST, source: 'Ticket_routing' }],
        ['a source with a hyphen', { ...POST, source: 'ticket-routing' }],
        ['a channel that is not a word', { ...POST, channel: 'Not A Word' }],
        ['an empty key', { ...POST, dedupKey: '' }],
        ['a key of 201 characters', { ...POST, dedupKey: 'k'.repeat(201) }],
        ['a key with a control character', { ...POST, dedupKey: 'k\u0000' }],
        ['a line that is not a string', { ...POST, lines: [7] }],
        ['a line with a line feed', { ...POST, lines: ['a\nb'] }],
        ['no post', null],
      ];
      for (const [what, post] of typeErrors) {
        await expect(ops.alerts.post(post as OpsDiscordPost), what).rejects.toBeInstanceOf(TypeError);
      }
      await expect(ops.alerts.post({ ...POST, dedupKey: 'none', lines: [] })).rejects.toBeInstanceOf(RangeError);
      await expect(ops.alerts.post({ ...POST, dedupKey: 'empty', lines: [''] })).rejects.toBeInstanceOf(RangeError);
      // Letters outside the hexadecimal ones, so the length alone decides.
      await expect(ops.alerts.post({ ...POST, dedupKey: 'long2', lines: ['x'.repeat(1_000), 'y'.repeat(1_000)] })).rejects.toBeInstanceOf(RangeError);
      expect(await ops.alerts.post({ ...POST, dedupKey: 'fits', lines: ['x'.repeat(1_000), 'y'.repeat(999)] })).toEqual({ id: expect.any(String) });
    });
  });

  it('8. without a discord hook a post writes its row and the drain marks it failed with no_hook after one ops_discord line', async () => {
    await within(async ({ prefix, clock, build }) => {
      const { ops, fixture } = build();
      expect(await ops.alerts.post(POST)).toEqual({ id: expect.any(String) });
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, failed: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'failed', lastAnswer: 'no_hook', mailState: 'none', settledAt: NOW });
      expect(fixture.recorder.linesOf('ops_discord')).toEqual([{ level: 'warn', message: 'ops_discord', fields: { channel: 'requests', outcome: 'no_hook', count: 1 } }]);
      expect(fixture.recorder.mails).toEqual([]);
      clock.advance(ALERT_GIVE_UP_MS);
      expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
    });
  });

  it("9. a hook or a mail that fails a statement through the handle it is given fails that try alone: the attempt is counted and the drain goes on (on PostgreSQL from a savepoint, so the claim's own writes land)", async () => {
    await within(async ({ prefix, clock, build }) => {
      const broken = async (handle: StorageAdapter) => handle.get('SELECT nothing FROM no_such_table_of_the_hook');
      let swallow = false;
      const { ops } = build({
        async discord(_post, handle) {
          if (swallow) {
            await broken(handle).catch(() => undefined);
            return { outcome: 'sent', deliveryId: 'm9' };
          }
          await broken(handle);
          return { outcome: 'sent', deliveryId: 'never' };
        },
      });
      await ops.alerts.post(POST);
      clock.advance(1);
      await ops.alerts.post({ ...POST, dedupKey: 'second' });
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 2 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 1, lastAnswer: 'no_answer' });
      expect(await stored(db, prefix, 'second')).toMatchObject({ state: 'pending', attempts: 1, lastAnswer: 'no_answer' });

      // A hook that swallows its own failed statement: on PostgreSQL its answer stands on an aborted transaction and counts as
      // failed, as a hook that throws does; on SQLite no transaction is poisoned, and its answer stands.
      swallow = true;
      clock.advance(alertBackoffMs(1));
      const run = await ops.alerts.sendDue(clock.now());
      if (backend.name === 'postgres') {
        expect(run).toEqual({ ...NOTHING, retried: 2 });
        expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 2, lastAnswer: 'no_answer' });
      } else {
        expect(run).toEqual({ ...NOTHING, sent: 2 });
        expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'm9' });
      }
    });

    await within(async ({ prefix, clock, build }) => {
      const { ops } = build({
        discord: async () => ({ outcome: 'failed', status: 502 }),
        async mail(_message, handle) {
          await handle.get('SELECT nothing FROM no_such_table_of_the_mail');
          return 'sent';
        },
      });
      await ops.alerts.post(POST);
      await ops.alerts.sendDue(clock.now());
      clock.set(NOW + ALERT_GIVE_UP_MS);
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, failed: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'failed', lastAnswer: 'gave_up', mailState: 'owed', mailAttempts: 1 });
    });
  });

  it('10. stop() waits for a running drain within its deadline, and no row begins once stop() has begun', async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops } = build({ discord: hook.hook });
      await ops.alerts.post(POST);
      clock.advance(1);
      await ops.alerts.post({ ...POST, dedupKey: 'second' });
      const held = deferred<OpsDiscordAnswer>();
      hook.answers.push(() => held.promise);

      const draining = ops.alerts.sendDue(clock.now());
      await vi.waitFor(() => expect(hook.calls).toHaveLength(1));
      let stopped = false;
      const stopping = ops.stop().then(() => {
        stopped = true;
      });
      await sleep(50);
      expect(stopped).toBe(false);
      held.resolve({ outcome: 'sent', deliveryId: 'm10' });
      await stopping;
      expect(await draining).toEqual({ ...NOTHING, sent: 1 });
      expect(hook.calls).toHaveLength(1);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'm10' });
      expect(await stored(db, prefix, 'second')).toMatchObject({ state: 'pending', attempts: 0 });
      expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
    });
  });

  it("11a. a drain whose read of a due row is answered after another drain delivered that row claims it not: the claim holds the row's state as read", async () => {
    await within(async ({ prefix, clock, second }) => {
      const hook = recordingHook();
      const timeout = 100;
      const a = createAlerts(createContext(fixtureOptions(db, { prefix, discord: hook.hook }, clock).options), { hookTimeoutMs: timeout });
      const read = holdOnce(isDueRead);
      const b = createAlerts(createContext(fixtureOptions(watched(await second(), { hold: read.hold }), { prefix, discord: hook.hook }, clock).options), {
        hookTimeoutMs: timeout,
      });
      await a.post(POST);
      const first = deferred<OpsDiscordAnswer>();
      hook.answers.push(() => first.promise);

      const draining = a.sendDue(clock.now());
      let late: Promise<typeof NOTHING> = Promise.resolve(NOTHING);
      try {
        await vi.waitFor(() => expect(hook.calls).toHaveLength(1));
        // Past the first claim's persisted deadline the row reads as due; the second drain's read answers only once the first has delivered it.
        clock.set(NOW + timeout + 1_000 + 500);
        late = b.sendDue(clock.now());
        await read.reached;
        first.resolve({ outcome: 'sent', deliveryId: 'first' });
        expect(await draining).toEqual({ ...NOTHING, sent: 1 });
      } catch (error) {
        // Settled on a failure too, so no claim's transaction stays open under the tables' drop.
        first.resolve({ outcome: 'sent', deliveryId: 'first' });
        read.release();
        throw error;
      }
      read.release();
      expect(await late).toEqual(NOTHING);
      expect(hook.calls).toHaveLength(1);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'first', attempts: 1 });
    });
  });

  it('11b. the bound never drops a row whose hook is running: the oldest other row goes, and the row in its hook is delivered', async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops, fixture } = build({ discord: hook.hook });
      await ops.alerts.post(POST);
      const held = deferred<OpsDiscordAnswer>();
      hook.answers.push(() => held.promise);
      const draining = ops.alerts.sendDue(clock.now());
      try {
        await vi.waitFor(() => expect(hook.calls).toHaveLength(1));

        // Keys of their own (the row in its hook holds `ticket_waiting:P-1:24`).
        for (let index = 1; index <= ALERT_PENDING_MAX; index += 1) {
          clock.advance(1);
          expect(await ops.alerts.post({ ...POST, dedupKey: `ticket_waiting:Q-${index}:24` })).toEqual({ id: expect.any(String) });
        }
        // 51 pending rows, one of them in its hook: the 50 others are within the bound.
        expect(await countRows(db, prefix, "state = 'pending'")).toBe(ALERT_PENDING_MAX + 1);
        expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending' });
        expect(await countRows(db, prefix, "state = 'dropped'")).toBe(0);
        expect(fixture.recorder.linesOf('ops_discord')).toEqual([]);

        clock.advance(1);
        await ops.alerts.post({ ...POST, dedupKey: `ticket_waiting:Q-${ALERT_PENDING_MAX + 1}:24` });
        expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending' });
        expect(await stored(db, prefix, 'ticket_waiting:Q-1:24')).toMatchObject({ state: 'dropped', lastAnswer: 'dropped' });
        expect(await countRows(db, prefix, "state = 'dropped'")).toBe(1);
      } finally {
        // Settled whatever passed above, so a failure never leaves the claim's transaction open under the tables' drop.
        held.resolve({ outcome: 'sent', deliveryId: 'm11' });
      }
      expect(await draining).toEqual({ ...NOTHING, sent: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'delivered', deliveryId: 'm11' });
      expect(await stored(db, prefix, 'ticket_waiting:Q-1:24')).toMatchObject({ state: 'dropped' });
    });
  });

  it('12. stop() begun while a drain reads its due row, or (on SQLite) while it claims it, starts no hook and writes no try: the row is left as it was', async () => {
    const isClaim = (sql: string, method: Method) => method === 'run' && /^UPDATE \S+ SET next_at = \?/.test(sql);
    type Case = readonly [what: string, matches: (sql: string, method: Method) => boolean, kind: 'hook' | 'no_hook' | 'give_up'];
    const cases: Case[] = [['the read', isDueRead, 'hook']];
    if (backend.name !== 'postgres') {
      cases.push(['the claim', isClaim, 'hook'], ['the claim of a row with no hook to try', isClaim, 'no_hook'], ['the claim of a row past its 24 hours', isClaim, 'give_up']);
    }
    for (const [what, matches, kind] of cases) {
      await within(async ({ prefix, clock, build }) => {
        const hook = recordingHook();
        const pause = holdOnce(matches, { armed: false });
        const { ops, fixture } = build(kind === 'no_hook' ? {} : { discord: hook.hook }, watched(db, { hold: pause.hold }));
        await ops.alerts.post(POST);
        let expected: Record<string, unknown> = { state: 'pending', attempts: 0, nextAt: NOW, lastAnswer: null };
        if (kind === 'give_up') {
          hook.answers.push({ outcome: 'failed', status: 503 });
          await ops.alerts.sendDue(clock.now());
          clock.set(NOW + ALERT_GIVE_UP_MS);
          expected = { state: 'pending', attempts: 1, nextAt: NOW + alertBackoffMs(1), lastAnswer: '503', mailState: 'none' };
        }
        const calls = hook.calls.length;
        pause.arm();

        const draining = ops.alerts.sendDue(clock.now());
        await pause.reached;
        const stopping = ops.stop();
        pause.release();
        await stopping;
        expect({ what, answer: await draining }).toEqual({ what, answer: NOTHING });
        expect({ what, calls: hook.calls.length }).toEqual({ what, calls });
        expect({ what, mails: fixture.recorder.mails.length }).toEqual({ what, mails: 0 });
        expect({ what, row: await stored(db, prefix, POST.dedupKey) }).toMatchObject({ what, row: expected });
      });
    }
  });

  it('13. a hook or a mail still running when stop() answers writes nothing once it returns: no statement runs on the handle after stop() has answered', async () => {
    for (const what of ['the hook', 'the mail'] as const) {
      await within(async ({ prefix, clock, build }) => {
        const hook = recordingHook();
        const late: string[] = [];
        let answered = false;
        const handle = watched(db, {
          seen(sql) {
            if (answered) late.push(sql);
          },
        });
        const mailHeld = deferred<'sent'>();
        let mailing = false;
        const { ops } = build(
          {
            discord: hook.hook,
            async mail() {
              mailing = true;
              return mailHeld.promise;
            },
          },
          handle,
        );
        await ops.alerts.post(POST);
        const held = deferred<OpsDiscordAnswer>();
        if (what === 'the hook') {
          hook.answers.push(() => held.promise);
        } else {
          hook.answers.push({ outcome: 'failed', status: 503 });
          await ops.alerts.sendDue(clock.now());
          clock.set(NOW + ALERT_GIVE_UP_MS);
        }

        const draining = ops.alerts.sendDue(clock.now());
        if (what === 'the hook') await vi.waitFor(() => expect(hook.calls).toHaveLength(1));
        else await vi.waitFor(() => expect(mailing).toBe(true));
        await ops.stop(); // past its 3 seconds: the hook or the mail is still running
        answered = true;
        held.resolve({ outcome: 'sent', deliveryId: 'after' });
        mailHeld.resolve('sent');
        expect({ what, answer: await draining }).toEqual({ what, answer: NOTHING });
        expect({ what, late }).toEqual({ what, late: [] });
        const row = await stored(db, prefix, POST.dedupKey);
        if (what === 'the hook') {
          // Not recorded: tried again by the next process (on SQLite once the claim lapses).
          expect({ what, row }).toMatchObject({ what, row: { state: 'pending', attempts: 0, deliveryId: null } });
        } else if (backend.name === 'postgres') {
          // The claim's transaction rolled back, the give-up with it.
          expect({ what, row }).toMatchObject({ what, row: { state: 'pending', attempts: 1, mailState: 'none' } });
        } else {
          expect({ what, row }).toMatchObject({ what, row: { state: 'failed', lastAnswer: 'gave_up', mailState: 'owed', mailAttempts: 0, settledAt: null } });
        }
      });
    }
  }, 30_000);

  it("13b. on PostgreSQL, stop() answering while a returned hook's or mail's savepoint is released stops the settlement there: no statement after it, and the claim rolls back", async () => {
    if (backend.name !== 'postgres') return; // SQLite holds no savepoint: nothing is awaited between the return and the settlement
    for (const what of ['the hook', 'the mail'] as const) {
      await within(async ({ prefix, clock, build }) => {
        const hook = recordingHook();
        const late: string[] = [];
        let answered = false;
        const release = holdOnce((sql, method) => method === 'exec' && sql.startsWith('RELEASE SAVEPOINT'), { armed: false });
        const handle = watched(db, {
          seen(sql) {
            if (answered) late.push(sql);
          },
          hold: release.hold,
        });
        const { ops, fixture } = build({ discord: hook.hook }, handle);
        await ops.alerts.post(POST);
        if (what === 'the mail') {
          hook.answers.push({ outcome: 'failed', status: 503 });
          await ops.alerts.sendDue(clock.now());
          clock.set(NOW + ALERT_GIVE_UP_MS);
        }
        release.arm();

        const draining = ops.alerts.sendDue(clock.now());
        try {
          await release.reached;
          await ops.stop(); // past its 3 seconds: the savepoint's release is held
          answered = true;
        } finally {
          release.release();
        }
        expect({ what, answer: await draining }).toEqual({ what, answer: NOTHING });
        expect({ what, late }).toEqual({ what, late: [] });
        expect({ what, sent: what === 'the hook' ? hook.calls.length : fixture.recorder.mails.length }).toEqual({ what, sent: 1 });
        expect({ what, row: await stored(db, prefix, POST.dedupKey) }).toMatchObject({
          what,
          row: what === 'the hook' ? { state: 'pending', attempts: 0, deliveryId: null } : { state: 'pending', attempts: 1, mailState: 'none' },
        });
      });
    }
  }, 30_000);

  it('13c. on SQLite, rows whose hooks are still awaited past their claims never fill the drain\'s read: a row due behind twenty of them is delivered', async () => {
    if (backend.name === 'postgres') return; // PostgreSQL's read skips a locked row before its LIMIT
    await within(async ({ prefix, clock }) => {
      const hook = recordingHook();
      const timeout = 100;
      const alertsOver = () => createAlerts(createContext(fixtureOptions(db, { prefix, discord: hook.hook }, clock).options), { hookTimeoutMs: timeout });
      const held = deferred<OpsDiscordAnswer>();
      const busy = 20;
      const first = alertsOver();
      for (let index = 0; index < busy; index += 1) {
        clock.advance(1);
        await first.post({ ...POST, dedupKey: `held:${index}` });
      }
      const drains: Array<Promise<typeof NOTHING>> = [];
      try {
        // Twenty operations over the one database, each drain's hook held: each claims the oldest row the others do not hold.
        for (let index = 0; index < busy; index += 1) {
          hook.answers.push(() => held.promise);
          drains.push((index === 0 ? first : alertsOver()).sendDue(clock.now()));
          await vi.waitFor(() => expect(hook.calls).toHaveLength(index + 1));
        }
        // Past every claim's persisted deadline: the twenty rows read as due again, and a new row is due behind them.
        clock.advance(timeout + 1_000 + 1_000);
        await first.post({ ...POST, dedupKey: 'behind' });
        expect(await alertsOver().sendDue(clock.now())).toEqual({ ...NOTHING, sent: 1 });
        expect(hook.calls.map((call) => call.post.dedupKey).at(-1)).toBe('behind');
        expect(await stored(db, prefix, 'behind')).toMatchObject({ state: 'delivered', deliveryId: 'm1' });
      } finally {
        held.resolve({ outcome: 'sent', deliveryId: 'late' });
      }
      expect((await Promise.all(drains)).reduce((sent, counts) => sent + counts.sent, 0)).toBe(busy);
      expect(await countRows(db, prefix, "state = 'delivered'")).toBe(busy + 1);
    });
  });

  it('14. a dedupKey holding a tab, a carriage return or a line feed is refused like any other control character, and writes nothing', async () => {
    await within(async ({ prefix, build }) => {
      const { ops } = build({ discord: recordingHook().hook });
      for (const [what, character] of [
        ['a tab', '\t'],
        ['a carriage return', '\r'],
        ['a line feed', '\n'],
        ['a next line', '\u0085'],
      ] as const) {
        await expect(ops.alerts.post({ ...POST, dedupKey: `ticket_waiting:${character}P-1:24` }), what).rejects.toBeInstanceOf(TypeError);
      }
      expect(await countRows(db, prefix)).toBe(0);
    });
  });

  it("15. a retry whose wait is zero, or rounds to zero, waits a second: one drain posts the row once", async () => {
    await within(async ({ prefix, clock, build }) => {
      const hook = recordingHook();
      const { ops, fixture } = build({ discord: hook.hook });
      await ops.alerts.post(POST);
      hook.answers.push({ outcome: 'retry', afterMs: 0, status: 429 }, { outcome: 'retry', afterMs: 0.4, status: 429 });

      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(hook.calls).toHaveLength(1);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', attempts: 1, lastAnswer: '429', nextAt: NOW + 1_000 });

      clock.advance(999);
      expect(await ops.alerts.sendDue(clock.now())).toEqual(NOTHING);
      clock.advance(1);
      expect(await ops.alerts.sendDue(clock.now())).toEqual({ ...NOTHING, retried: 1 });
      expect(hook.calls).toHaveLength(2);
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ attempts: 2, nextAt: NOW + 2_000 });
      expect(fixture.recorder.linesOf('delivery_retry').map((line) => line.fields)).toEqual([
        { channel: 'requests', answer: 'rate_limited', status: 429, wait_s: 1 },
        { channel: 'requests', answer: 'rate_limited', status: 429, wait_s: 1 },
      ]);
    });
  });

  it("16. each row of a drain is timed by the host's clock as it is tried: its claim, its first try, its next try and its delivery", async () => {
    await within(async ({ prefix, clock, build }) => {
      const minutes10 = 600_000;
      const claimed: number[] = [];
      const answers: OpsDiscordAnswer[] = [
        { outcome: 'failed', status: 500 },
        { outcome: 'sent', deliveryId: 'm16' },
      ];
      const { ops } = build({
        async discord(post, handle) {
          // On SQLite the claim is the row's next try moved past the deadline; on PostgreSQL it is the row's lock.
          if (backend.name !== 'postgres') {
            const row = await handle.get<{ next_at: number | string }>(`SELECT next_at FROM ${prefix}_discord_outbox WHERE dedup_key = ?`, [post.dedupKey]);
            claimed.push(Number(row?.next_at));
          }
          clock.advance(minutes10);
          return answers.shift() ?? { outcome: 'failed', status: null };
        },
      });
      await ops.alerts.post(POST);
      clock.advance(1);
      await ops.alerts.post({ ...POST, dedupKey: 'second' });
      const start = clock.now();

      expect(await ops.alerts.sendDue(start)).toEqual({ ...NOTHING, sent: 1, retried: 1 });
      expect(await stored(db, prefix, POST.dedupKey)).toMatchObject({ state: 'pending', firstAttemptAt: start, nextAt: start + minutes10 + alertBackoffMs(1) });
      expect(await stored(db, prefix, 'second')).toMatchObject({
        state: 'delivered',
        firstAttemptAt: start + minutes10,
        deliveredAt: start + 2 * minutes10,
        settledAt: start + 2 * minutes10,
      });
      if (backend.name !== 'postgres') {
        expect(claimed).toEqual([start + ALERT_HOOK_TIMEOUT_MS + 1_000, start + minutes10 + ALERT_HOOK_TIMEOUT_MS + 1_000]);
      }
    });
  });

  it('17. a key prefix is matched as written on both databases: case counts, and a character outside the basic plane is one character', async () => {
    await within(async ({ clock, build }) => {
      const { ops } = build({ discord: recordingHook().hook });
      for (const dedupKey of ['Job_failed:a', 'job_failed:b', '\u{1F514}:c']) {
        clock.advance(1);
        await ops.alerts.post({ ...POST, dedupKey });
      }
      const keys = async (prefix: string) => (await ops.alerts.list({ prefix })).map((row) => row.dedupKey);
      expect(await keys('job_failed:')).toEqual(['job_failed:b']);
      expect(await keys('Job_failed:')).toEqual(['Job_failed:a']);
      expect(await keys('JOB_')).toEqual([]);
      expect(await keys('\u{1F514}')).toEqual(['\u{1F514}:c']);
      expect(await keys('\u{1F514}:c')).toEqual(['\u{1F514}:c']);
      expect(await keys('\u{1F514}:cd')).toEqual([]);
      expect(await keys('')).toEqual(['\u{1F514}:c', 'job_failed:b', 'Job_failed:a']);
    });
  });
});
