/**
 * The fixture host: a `fields` rule with `session` as the one id key, two metrics, English words,
 * six categories, and a recording `mail`, `notify`, `audit` and logger.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type {
  OpsAuditEntry,
  OpsFields,
  OpsLogger,
  OpsMail,
  OpsMetric,
  OpsNotice,
  OpsOptions,
} from '../../src/contract.js';
import { englishWords } from '../../src/words.js';
import { fakeClock, type FakeClock } from './clock.js';

export interface LoggedLine {
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

export interface Recorder {
  readonly lines: LoggedLine[];
  readonly mails: OpsMail[];
  readonly notices: OpsNotice[];
  readonly audits: OpsAuditEntry[];
  readonly logger: OpsLogger;
  /** The logged lines whose message is `message`. */
  linesOf(message: string): LoggedLine[];
}

export function recorder(): Recorder {
  const lines: LoggedLine[] = [];
  const log = (level: LoggedLine['level']) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
  };
  return {
    lines,
    mails: [],
    notices: [],
    audits: [],
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    linesOf(message) {
      return lines.filter((line) => line.message === message);
    },
  };
}

export const FIXTURE_FIELDS: OpsFields = {
  status: { kind: 'integer' },
  ms: { kind: 'integer' },
  n: { kind: 'integer' },
  kind: { kind: 'word', words: ['request', 'error', 'job', 'mail'] },
  state: { kind: 'word', words: ['ok', 'failed', 'skipped'] },
  session: { kind: 'id' },
  path: { kind: 'path' },
};

/**
 * The fixture host's route patterns: a 32-character hex segment, as a token or an id in a path,
 * becomes `[id]`, and a pattern answers itself, as D40 asks of a host's `routePattern`.
 */
export const fixtureRoutePattern = (pathname: string): string | null =>
  pathname.startsWith('/') ? pathname.replace(/\/[0-9a-f]{32}(?=\/|$)/g, '/[id]') : null;

export const FIXTURE_CATEGORIES = ['billing', 'bug', 'account', 'privacy', 'question', 'other'] as const;

export const FIXTURE_PLANS = ['free', 'plus'] as const;

/** The host's two metrics: fixed figures by plan, enough for the totals to have rows. */
export const FIXTURE_METRICS: Readonly<Record<'signups' | 'minutes', OpsMetric>> = {
  signups: async () => [
    { plan: 'free', value: 3 },
    { plan: 'plus', value: 1 },
  ],
  minutes: async () => [
    { plan: 'free', value: 40 },
    { plan: 'plus', value: 120 },
  ],
};

export interface Fixture {
  readonly options: OpsOptions;
  readonly recorder: Recorder;
  readonly clock: FakeClock;
}

/** The fixture host's options over `db`, with `overrides` laid on top. */
export function fixtureOptions(db: StorageAdapter, overrides: Partial<OpsOptions> = {}, clock: FakeClock = fakeClock()): Fixture {
  const record = recorder();
  const options: OpsOptions = {
    db,
    prefix: 'ops',
    release: 'test',
    process: 'web',
    locks: [101, 102, 103],
    alertsTo: 'team@example.invalid',
    logger: record.logger,
    async mail(message) {
      record.mails.push(message);
      return 'sent';
    },
    routePattern: fixtureRoutePattern,
    fields: FIXTURE_FIELDS,
    tickets: {
      identity: async () => ({ name: 'Fixture Person', email: 'person@example.invalid' }),
      audit: async (_trx, entry) => {
        record.audits.push(entry);
      },
      staffRecipients: async () => ['team@example.invalid'],
      notify: async (notice) => {
        record.notices.push(notice);
      },
      categories: FIXTURE_CATEGORIES,
      words: englishWords,
      tokenPaths: ['/sign-in', '/invite'],
      excluded: async () => [],
    },
    metrics: {
      plans: FIXTURE_PLANS,
      metrics: FIXTURE_METRICS,
      excluded: async () => [],
    },
    now: clock.now,
    ...overrides,
  };
  return { options, recorder: record, clock };
}
