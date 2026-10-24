import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { describe, expect, it, vi } from 'vitest';
import { checkFields, createFieldGate, requireFieldRules } from '../src/fields.js';
import { createOperations } from '../src/index.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, fixtureOptions, fixtureRoutePattern, recorder } from './helpers/host.js';

/** An adapter that answers every call with nothing, for a case that writes no row. */
function idleDb(): StorageAdapter {
  const db = {
    kind: 'sqljs',
    run: async () => ({ changes: 0 }),
    get: async () => null,
    all: async () => [],
    exec: async () => undefined,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => work(db),
  };
  return db as unknown as StorageAdapter;
}

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SESSION = '0123456789abcdef0123456789abcdef';

/** The rule as an entry calls it, with the fixture host's route patterns. */
const check = (fields: unknown) => checkFields(FIXTURE_FIELDS, fields, fixtureRoutePattern);

describe('the fields rule', () => {
  it('refuses a token under a word key, an unknown key, a sentence under a word key, a non-integer under an integer key, and /reset/<32 characters> under path, and keeps an id under an id key and a pattern under path', () => {
    expect(check({ kind: TOKEN })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'kind', reason: 'word' } });
    expect(check({ email: 'person@example.invalid' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'email', reason: 'unknown' } });
    expect(check({ kind: 'the person wrote this sentence here' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'kind', reason: 'word' } });
    expect(check({ status: 1.5 })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(check({ status: '200' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(check({ status: Number.MAX_SAFE_INTEGER + 2 })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(check({ session: SESSION.slice(0, 31) })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'id' } });
    expect(check({ session: TOKEN })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'id' } });
    expect(check({ path: '/search?q=a sentence' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'path', reason: 'path' } });
    expect(check({ path: `/reset/${SESSION}` })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'path', reason: 'path' } });
    expect(check({ session: { nested: 1 } })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'shape' } });
    expect(check({ status: [200] })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'shape' } });
    expect(check({ status: null })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(check('not an object')).toEqual({ ok: false, refusal: { refused: 'fields', key: 'fields', reason: 'shape' } });
    expect(check([{ status: 200 }])).toEqual({ ok: false, refusal: { refused: 'fields', key: 'fields', reason: 'shape' } });

    const kept = check({ status: 200, ms: 12, kind: 'request', session: SESSION, path: '/api/v1/sessions/[id]/notes.json:read' });
    expect(kept).toEqual({ ok: true, fields: { status: 200, ms: 12, kind: 'request', session: SESSION, path: '/api/v1/sessions/[id]/notes.json:read' } });
    expect(check({ session: SESSION.toUpperCase() }).ok).toBe(true);
    expect(check({})).toEqual({ ok: true, fields: {} });
  });

  it("names the first offending key in the object's order", () => {
    const answer = check({ status: 200, nope: 1, kind: TOKEN });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.key).toBe('nope');
  });

  it('refuses a token, a whole address, an empty segment and an unrooted path under path, and keeps a rooted pattern and unknown', () => {
    const refused = { ok: false, refusal: { refused: 'fields', key: 'path', reason: 'path' } };
    for (const value of [
      TOKEN,
      'https://example.invalid/sign-in/0123456789abcdef0123456789abcdef',
      '//example.invalid/sign-in',
      '/api//v1',
      'api/v1/sessions',
      '',
      `/${'a'.repeat(512)}`,
    ]) {
      expect({ value, answer: check({ path: value }) }).toEqual({ value, answer: refused });
    }
    for (const value of ['/', '/api/v1/sessions/[id]/notes.json:read', '/api/v1/meeting-bots/:id/leave', '/app/[[...slug]]', '/app/', 'unknown']) {
      expect(check({ path: value })).toEqual({ ok: true, fields: { path: value } });
    }
  });

  it("refuses a concrete path the host's routePattern maps to another pattern or to nothing, and a routePattern that throws, never throwing itself", () => {
    const refused = { ok: false, refusal: { refused: 'fields', key: 'path', reason: 'path' } };
    for (const value of [`/reset/${SESSION}`, `/sign-in/${SESSION}/confirm`, `/invite/${SESSION}`]) {
      expect({ value, answer: check({ path: value }) }).toEqual({ value, answer: refused });
    }
    expect(checkFields(FIXTURE_FIELDS, { path: '/app' }, () => null)).toEqual(refused);
    expect(checkFields(FIXTURE_FIELDS, { path: '/app' }, () => '/somewhere-else')).toEqual(refused);
    const throwing = () => {
      throw new Error('a host bug');
    };
    expect(checkFields(FIXTURE_FIELDS, { path: '/app' }, throwing)).toEqual(refused);
    // The word for a path no route matches never reaches the host.
    expect(checkFields(FIXTURE_FIELDS, { path: 'unknown' }, throwing)).toEqual({ ok: true, fields: { path: 'unknown' } });
  });

  it("checks a value as the path rule does through the gate, for an entry's own path column", () => {
    const gate = createFieldGate(FIXTURE_FIELDS, recorder().logger, fakeClock().now, fixtureRoutePattern);
    expect(gate.path('/api/v1/sessions/[id]')).toBe(true);
    expect(gate.path('unknown')).toBe(true);
    expect(gate.path(`/reset/${SESSION}`)).toBe(false);
    expect(gate.path('https://example.invalid/app')).toBe(false);
    expect(gate.path(200)).toBe(false);
  });

  it('counts refusals into one ops_refused line a minute naming a declared key, an undeclared one as unknown, never the value', () => {
    const clock = fakeClock();
    const record = recorder();
    const gate = createFieldGate(FIXTURE_FIELDS, record.logger, clock.now, fixtureRoutePattern);

    expect(gate.check({ kind: TOKEN })).toBeNull();
    expect(gate.check({ kind: 'a sentence a person wrote' })).toBeNull();
    expect(gate.check({ status: 200 })).toEqual({ status: 200 });
    expect(record.linesOf('ops_refused')).toEqual([]);

    clock.advance(61_000);
    expect(gate.check({ kind: TOKEN })).toBeNull();
    expect(record.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'kind', count: 2 } }]);

    gate.drain();
    expect(record.linesOf('ops_refused')).toHaveLength(1);
    clock.advance(61_000);
    gate.drain();
    expect(record.linesOf('ops_refused')).toHaveLength(2);
    expect(record.linesOf('ops_refused')[1]?.fields).toEqual({ key: 'kind', count: 1 });

    // An undeclared key can itself be an address or a name, so it is counted as unknown.
    gate.check({ status: 'x' });
    gate.check({ [TOKEN]: 1 });
    gate.check({ person_at_example_invalid: 1 });
    gate.check({ johnsmith: 'x' });
    gate.drain(true);
    expect(record.linesOf('ops_refused').slice(2)).toEqual([
      { level: 'warn', message: 'ops_refused', fields: { key: 'status', count: 1 } },
      { level: 'warn', message: 'ops_refused', fields: { key: 'unknown', count: 3 } },
    ]);
    const written = JSON.stringify(record.lines);
    for (const value of [TOKEN, 'sentence', 'person_at_example_invalid', 'johnsmith']) expect(written).not.toContain(value);
  });

  it("never throws from the gate when the host's logger throws, since an entry that calls it never throws (D47)", () => {
    const clock = fakeClock();
    const closed = () => {
      throw new Error('the log stream is closed');
    };
    const gate = createFieldGate(FIXTURE_FIELDS, { info: closed, warn: closed, error: closed }, clock.now, fixtureRoutePattern);
    expect(gate.check({ kind: TOKEN })).toBeNull();
    expect(gate.check({ unknown_key: 1 })).toBeNull();
    clock.advance(61_000);
    // The minute has turned, so this refusal writes the held lines first, and the logger throws on each.
    expect(() => gate.check({ kind: TOKEN })).not.toThrow();
    expect(() => gate.drain(true)).not.toThrow();
    expect(gate.check({ status: 200 })).toEqual({ status: 200 });
  });

  it("a started process writes a minute's ops_refused line once the minute has ended, with no later refusal to carry it and before any stop", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const clock = fakeClock();
      const fixture = fixtureOptions(idleDb(), {}, clock);
      const operations = createOperations(fixture.options);
      operations.start({ shared: false });
      operations.lines.push({ process: 'web', kind: 'request', fields: { email: 'person@example.invalid' } });

      // The minute has not ended, so nothing is written yet.
      vi.advanceTimersByTime(10_000);
      expect(fixture.recorder.linesOf('ops_refused')).toEqual([]);

      // The minute ends and no other refusal comes: the line is written within seconds, not held until stop().
      clock.advance(61_000);
      vi.advanceTimersByTime(10_000);
      expect(fixture.recorder.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'unknown', count: 1 } }]);

      const stopped = operations.stop();
      vi.advanceTimersByTime(3_000);
      await stopped;
      expect(fixture.recorder.linesOf('ops_refused')).toHaveLength(1);
      expect(JSON.stringify(fixture.recorder.lines)).not.toContain('person@example.invalid');
    } finally {
      vi.useRealTimers();
    }
  });

  it("a host logger that pushes what it logs, under a rule that refuses the ops_refused line, gets one line a key a minute: the refusal that line causes waits for the next minute's drain and never re-enters the one writing", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const clock = fakeClock();
      const record = recorder();
      let operations: ReturnType<typeof createOperations> | undefined;
      // The host's logger records each line, then pushes it as one of the product's own lines; the fixture
      // rule admits neither the kind ops_refused nor the keys key and count, so each such line is refused.
      const pushBack =
        (level: 'info' | 'warn' | 'error') =>
        (message: string, fields?: Record<string, unknown>): void => {
          record.logger[level](message, fields);
          operations?.lines.push({ process: 'web', kind: message, fields });
        };
      const fixture = fixtureOptions(idleDb(), { logger: { info: pushBack('info'), warn: pushBack('warn'), error: pushBack('error') } }, clock);
      operations = createOperations(fixture.options);
      operations.start({ shared: false });
      operations.lines.push({ process: 'web', kind: 'request', fields: { email: 'person@example.invalid' } });

      // The minute ends: the timer writes the minute's one line, and the refusal of that line pushed back waits.
      clock.advance(61_000);
      vi.advanceTimersByTime(5_000);
      expect(record.linesOf('ops_refused')).toEqual([{ level: 'warn', message: 'ops_refused', fields: { key: 'unknown', count: 1 } }]);

      // The next minute's drain writes that one refusal, under the key its kind was refused at, and no more.
      clock.advance(61_000);
      vi.advanceTimersByTime(5_000);
      expect(record.linesOf('ops_refused')).toEqual([
        { level: 'warn', message: 'ops_refused', fields: { key: 'unknown', count: 1 } },
        { level: 'warn', message: 'ops_refused', fields: { key: 'kind', count: 1 } },
      ]);

      const stopped = operations.stop();
      vi.advanceTimersByTime(3_000);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks a product's rule at creation and names the key it refuses", () => {
    expect(requireFieldRules(FIXTURE_FIELDS)).toBe(FIXTURE_FIELDS);
    expect(() => requireFieldRules({})).toThrow(TypeError);
    expect(() => requireFieldRules({ kind: { kind: 'word', words: [] } })).toThrow(/fields\.kind/);
    expect(() => requireFieldRules({ kind: { kind: 'sentence' } })).toThrow(/fields\.kind\.kind/);
    expect(() => requireFieldRules({ 'two words': { kind: 'integer' } })).toThrow(/not a word/);
    expect(() => requireFieldRules({ kind: { kind: 'word', words: ['has space'] } })).toThrow(/fields\.kind/);
  });
});
