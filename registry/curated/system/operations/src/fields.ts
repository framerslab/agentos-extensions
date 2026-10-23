/**
 * @fileoverview The `fields` rule (D40): a closed list of keys the product declares, each an
 * integer key, a word key with its words, an id key or `path`. `checkFields` answers the checked
 * object or a refusal naming the first offending key; the gate counts refusals into one
 * `ops_refused` line a key a minute through the logger, with the count and the key's name, never
 * the value.
 */
import type { OpsFieldRule, OpsFields, OpsLogger } from './contract.js';

export type OpsFieldValue = number | string;
export type OpsCheckedFields = Readonly<Record<string, OpsFieldValue>>;
export type OpsFieldReason = 'shape' | 'unknown' | 'integer' | 'word' | 'id' | 'path';

export interface OpsFieldRefusal {
  readonly refused: 'fields';
  readonly key: string;
  readonly reason: OpsFieldReason;
}

export type OpsFieldsAnswer =
  | { readonly ok: true; readonly fields: OpsCheckedFields }
  | { readonly ok: false; readonly refusal: OpsFieldRefusal };

/** 32 hex characters: a 128-bit id. */
const ID = /^[0-9a-fA-F]{32}$/;
/** A route pattern: letters, digits, `/`, `[`, `]`, `_`, `-`, `.` and `:`, at most 512 characters. */
const PATH = /^[A-Za-z0-9/[\]_\-.:]{1,512}$/;
/** A key the package declares or logs: a letter, then at most 63 letters, digits or underscores. */
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A word a rule may list: 1 to 64 characters, none of them a space or a control character. */
const WORD = /^[^\s\u0000-\u001F\u007F-\u009F]{1,64}$/;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const refuse = (key: string, reason: OpsFieldReason): OpsFieldsAnswer => ({
  ok: false,
  refusal: { refused: 'fields', key, reason },
});

/** The reason one value fails its rule, or null when it passes. */
function reasonOf(rule: OpsFieldRule, value: unknown): OpsFieldReason | null {
  if (plain(value) || Array.isArray(value)) return 'shape';
  switch (rule.kind) {
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? null : 'integer';
    case 'word':
      return typeof value === 'string' && rule.words.includes(value) ? null : 'word';
    case 'id':
      return typeof value === 'string' && ID.test(value) ? null : 'id';
    case 'path':
      return typeof value === 'string' && PATH.test(value) ? null : 'path';
    default:
      return 'shape';
  }
}

/**
 * Checks `fields` against `rule`: an unknown key, a non-integer under an integer key, a word
 * outside the list under a word key, a value under an id key that is not 32 hex characters, a path
 * that is not a route pattern, a nested object or an array, each refuses, naming the first
 * offending key. A value that is not a plain object refuses under the key `fields`.
 */
export function checkFields(rule: OpsFields, fields: unknown): OpsFieldsAnswer {
  if (!plain(fields)) return refuse('fields', 'shape');
  const checked: Record<string, OpsFieldValue> = {};
  for (const key of Object.keys(fields)) {
    const own = Object.prototype.hasOwnProperty.call(rule, key) ? rule[key] : undefined;
    if (own === undefined) return refuse(key, 'unknown');
    const value = fields[key];
    const reason = reasonOf(own, value);
    if (reason !== null) return refuse(key, reason);
    checked[key] = value as OpsFieldValue;
  }
  return { ok: true, fields: checked };
}

/**
 * Checks a product's rule at `createOperations`: a non-empty plain object whose keys are words,
 * each rule one of the four kinds, a word rule with one or more words. Throws a `TypeError`
 * naming the key.
 */
export function requireFieldRules(rule: unknown): OpsFields {
  if (!plain(rule) || Object.keys(rule).length === 0) {
    throw new TypeError('createOperations: fields must be a non-empty object of field rules');
  }
  for (const [key, entry] of Object.entries(rule)) {
    if (!KEY.test(key)) throw new TypeError(`createOperations: fields has a key that is not a word`);
    if (!plain(entry)) throw new TypeError(`createOperations: fields.${key} must be a rule object`);
    switch (entry.kind) {
      case 'integer':
      case 'id':
      case 'path':
        break;
      case 'word': {
        const words = entry.words;
        if (!Array.isArray(words) || words.length === 0 || !words.every((word) => typeof word === 'string' && WORD.test(word))) {
          throw new TypeError(`createOperations: fields.${key} must list one or more words`);
        }
        break;
      }
      default:
        throw new TypeError(`createOperations: fields.${key}.kind must be integer, word, id or path`);
    }
  }
  return rule as OpsFields;
}

/** The key as an `ops_refused` line names it: the key when it is a word, else `other`. */
const loggable = (key: string): string => (KEY.test(key) ? key : 'other');

const MINUTE = 60_000;

/**
 * Counts refusals and writes one `ops_refused` line a key a minute. A refusal in a later minute
 * than the counts held writes the held minute's lines first; `drain` writes what is held, at a
 * tick or at `stop()`, when the minute has turned or `force` is set.
 */
export class RefusalCounter {
  private minute = -1;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly logger: OpsLogger,
    private readonly now: () => number,
  ) {}

  /** Counts one refusal of `key` at the clock's time. */
  count(key: string): void {
    const at = this.now();
    this.drain(false, at);
    const named = loggable(key);
    if (this.minute === -1) this.minute = Math.floor(at / MINUTE);
    this.counts.set(named, (this.counts.get(named) ?? 0) + 1);
  }

  /** Writes the held minute's lines when the minute has turned, or always when `force` is set. */
  drain(force = false, at = this.now()): void {
    if (this.counts.size === 0) return;
    const minute = Math.floor(at / MINUTE);
    if (!force && minute === this.minute) return;
    for (const [key, count] of this.counts) this.logger.warn('ops_refused', { key, count });
    this.counts.clear();
    this.minute = -1;
  }
}

/** The one check every entry calls (D40): the checked fields, or null after the refusal is counted. */
export interface FieldGate {
  readonly rule: OpsFields;
  check(fields: unknown): OpsCheckedFields | null;
  /** Writes the held `ops_refused` lines; `force` writes them whatever the minute. */
  drain(force?: boolean): void;
}

export function createFieldGate(rule: OpsFields, logger: OpsLogger, now: () => number): FieldGate {
  const counter = new RefusalCounter(logger, now);
  return {
    rule,
    check(fields) {
      const answer = checkFields(rule, fields);
      if (answer.ok) return answer.fields;
      counter.count(answer.refusal.key);
      return null;
    },
    drain(force = false) {
      counter.drain(force);
    },
  };
}
