import { describe, expect, it } from 'vitest';
import { checkFields, createFieldGate, requireFieldRules } from '../src/fields.js';
import { fakeClock } from './helpers/clock.js';
import { FIXTURE_FIELDS, recorder } from './helpers/host.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SESSION = '0123456789abcdef0123456789abcdef';

describe('the fields rule', () => {
  it('refuses a token under a word key, an unknown key, a sentence under a word key, a non-integer under an integer key, and keeps an id under an id key and a pattern under path', () => {
    expect(checkFields(FIXTURE_FIELDS, { kind: TOKEN })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'kind', reason: 'word' } });
    expect(checkFields(FIXTURE_FIELDS, { email: 'person@example.invalid' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'email', reason: 'unknown' } });
    expect(checkFields(FIXTURE_FIELDS, { kind: 'the person wrote this sentence here' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'kind', reason: 'word' } });
    expect(checkFields(FIXTURE_FIELDS, { status: 1.5 })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(checkFields(FIXTURE_FIELDS, { status: '200' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(checkFields(FIXTURE_FIELDS, { status: Number.MAX_SAFE_INTEGER + 2 })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(checkFields(FIXTURE_FIELDS, { session: SESSION.slice(0, 31) })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'id' } });
    expect(checkFields(FIXTURE_FIELDS, { session: TOKEN })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'id' } });
    expect(checkFields(FIXTURE_FIELDS, { path: '/search?q=a sentence' })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'path', reason: 'path' } });
    expect(checkFields(FIXTURE_FIELDS, { session: { nested: 1 } })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'session', reason: 'shape' } });
    expect(checkFields(FIXTURE_FIELDS, { status: [200] })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'shape' } });
    expect(checkFields(FIXTURE_FIELDS, { status: null })).toEqual({ ok: false, refusal: { refused: 'fields', key: 'status', reason: 'integer' } });
    expect(checkFields(FIXTURE_FIELDS, 'not an object')).toEqual({ ok: false, refusal: { refused: 'fields', key: 'fields', reason: 'shape' } });
    expect(checkFields(FIXTURE_FIELDS, [{ status: 200 }])).toEqual({ ok: false, refusal: { refused: 'fields', key: 'fields', reason: 'shape' } });

    const kept = checkFields(FIXTURE_FIELDS, { status: 200, ms: 12, kind: 'request', session: SESSION, path: '/api/v1/sessions/[id]/notes.json:read' });
    expect(kept).toEqual({ ok: true, fields: { status: 200, ms: 12, kind: 'request', session: SESSION, path: '/api/v1/sessions/[id]/notes.json:read' } });
    expect(checkFields(FIXTURE_FIELDS, { session: SESSION.toUpperCase() }).ok).toBe(true);
    expect(checkFields(FIXTURE_FIELDS, {})).toEqual({ ok: true, fields: {} });
  });

  it("names the first offending key in the object's order", () => {
    const answer = checkFields(FIXTURE_FIELDS, { status: 200, nope: 1, kind: TOKEN });
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
      expect({ value, answer: checkFields(FIXTURE_FIELDS, { path: value }) }).toEqual({ value, answer: refused });
    }
    for (const value of ['/', '/api/v1/sessions/[id]/notes.json:read', '/api/v1/meeting-bots/:id/leave', '/app/[[...slug]]', '/app/', 'unknown']) {
      expect(checkFields(FIXTURE_FIELDS, { path: value })).toEqual({ ok: true, fields: { path: value } });
    }
  });

  it('counts refusals into one ops_refused line a minute naming the key, never the value', () => {
    const clock = fakeClock();
    const record = recorder();
    const gate = createFieldGate(FIXTURE_FIELDS, record.logger, clock.now);

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

    gate.check({ status: 'x' });
    gate.check({ [TOKEN]: 1 });
    gate.drain(true);
    expect(record.linesOf('ops_refused').slice(2)).toEqual([
      { level: 'warn', message: 'ops_refused', fields: { key: 'status', count: 1 } },
      { level: 'warn', message: 'ops_refused', fields: { key: 'other', count: 1 } },
    ]);
    expect(JSON.stringify(record.lines)).not.toContain(TOKEN);
    expect(JSON.stringify(record.lines)).not.toContain('sentence');
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
