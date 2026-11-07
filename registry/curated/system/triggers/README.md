# @framers/agentos-ext-triggers

[![CI Status](https://github.com/framerslab/agentos-extensions/workflows/CI/badge.svg)](https://github.com/framerslab/agentos-extensions/actions)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A scheduler of record in a product's own database, through the SQL storage adapter it already passes. Jobs are defined in code and registered when the process starts; their rows, their runs and the due times they missed live in three tables under a prefix of the product's choosing. A lease with a claim token gives each due time one run across processes, a missed-run rule decides what a job does with the due times it missed while its process was down or it was paused, and staff pause, resume and run a job by hand through the rows, with an audit hook the product writes its own record through.

```ts
import { computeNextRunAtMs, migrateTriggers, scheduleWords } from '@framers/agentos-ext-triggers';

await migrateTriggers(db, { prefix: 'trig', lockKey: 724313571 });

const next = computeNextRunAtMs({ kind: 'cron', expr: '20 0 * * *' }, Date.now()); // the next 00:20 UTC
const words = scheduleWords({ kind: 'cron', expr: '20 0 * * *' }); // "Daily at 00:20 UTC"
```

## What this release holds

| Part | In this release |
|---|---|
| `migrateTriggers` | Builds `<prefix>_jobs`, `<prefix>_runs`, `<prefix>_missed` and their migration ledger, `<prefix>_schema_migrations`, on PostgreSQL and SQLite. |
| `computeNextRunAtMs` | The next due time of a schedule strictly after a given time, or `undefined` when there is none. |
| `scheduleWords` | The sentence a schedule reads as on a jobs page. |
| The types | `Schedule`, `MissedRunRule`, `JobDefinition`, `RunContext`, `RunSummary`, `JobState`, `RunOutcome`, `JobView`, `RunView`, `MissedView`, `TriggersRefusal`, `TriggersAuditEntry`, `TriggersLogger`, `Keep`, `TriggersOptions`, `Scheduler`, `Watcher`. |

`createScheduler` (registration, the restore and the missed-run rules, the tick, the lease, retries, pause, resume, run now and the reads) and `createWatcher` (the stall watcher, reports-only rows and the retention of runs) follow in the next two pull requests of this package. The package stays private until the last of them, and its first version, 0.1.0, publishes with that merge.

## Installation

```bash
npm install @framers/agentos-ext-triggers @framers/sql-storage-adapter
```

Node 22 or later. `@framers/sql-storage-adapter` 0.7.15 or later is an optional peer: the package loads it when `migrateTriggers` runs, so a process that only reads schedules never needs it.

## Adopting it

1. **Migrate.** The product's migration command calls `migrateTriggers` after the operations package's tables and before its own migrations, with the lock key its own runner takes:

   ```ts
   await migrateTriggers(db, { prefix: 'trig', lockKey });
   ```

   It builds the three tables and the ledger under the prefix; run again, it applies nothing. A prefix is a lower-case letter followed by at most 32 lower-case letters, digits or underscores, `trig` when none is given; on SQLite, `sqlite` and a prefix beginning `sqlite_` are refused, since SQLite keeps those names for itself. The lock key is 724313571 when none is given, the adapter runner's own default, which the operations package takes too, so runners that share a database share a key.

Registering jobs, starting the scheduler in the process that runs them, the reads and commands in the other processes and the stall watcher are the steps `createScheduler` and `createWatcher` bring.

## Schedules

Three kinds. Every time is milliseconds since the epoch, and every clock is UTC.

| Kind | Shape | The next due time after `afterMs` |
|---|---|---|
| `at` | `{ kind: 'at', at }` | `at`, when it is later than `afterMs`; otherwise none. |
| `every` | `{ kind: 'every', everyMs, anchorMs? }` | `afterMs + everyMs`; with an anchor, the next step of the anchor's grid, or the anchor itself while it is ahead. An interval that is not a positive integer has none. |
| `cron` | `{ kind: 'cron', expr }` | The next whole minute whose UTC fields match. |

A cron expression has five fields: the minute (0 to 59), the hour (0 to 23), the day of the month (1 to 31), the month (1 to 12) and the day of the week (0 to 6, 0 for Sunday). A field is `*`, a number, a range `a-b`, a step `*/n`, `a-b/n` or `a/n` (from `a` to the field's end), or a comma list of these. Every value, range and step is checked when the expression is parsed: a step of 0, a value outside its field, a reversed range, an empty part, a word or a count of fields other than five throws a `RangeError` named `CronRefused`, which says the reason and the expression. A restricted day of the month and a restricted day of the week must both match (`0 0 13 * 5` is a Friday the 13th), where [crontab(5)](https://man7.org/linux/man-pages/man5/crontab.5.html) runs a line when either matches. The search steps a day at a time over one 400-year Gregorian cycle, after which the calendar repeats, so a match years away is found (`30 6 29 2 1`, 29 February on a Monday, comes 40 years apart across 2100) and an expression no day can match answers `undefined` (`0 0 31 2 *`). It reads the UTC fields only, so neither the host's zone nor its daylight-saving changes move a due time.

`scheduleWords` reads a schedule as one of these forms:

| Schedule | Words |
|---|---|
| `{ kind: 'every', everyMs: 300_000 }` | Every 5 minutes |
| `{ kind: 'every', everyMs: 8 * 86_400_000 }` | Every 8 days |
| `{ kind: 'cron', expr: '*/15 * * * *' }` | Every 15 minutes |
| `{ kind: 'cron', expr: '40 * * * *' }` | Every hour at :40 |
| `{ kind: 'cron', expr: '20 0 * * *' }` | Daily at 00:20 UTC |
| `{ kind: 'cron', expr: '23 8 * * 1' }` | Weekly on Monday at 08:23 UTC |
| `{ kind: 'cron', expr: '0 6 1 * *' }` | Monthly on day 1 at 06:00 UTC |
| `{ kind: 'at', at: Date.UTC(2026, 10, 4, 9, 0) }` | Once, 4 Nov 09:00 UTC |

Any other cron expression reads `Cron <expr> UTC`. A minute step reads as an interval only when it divides the hour: `*/7` runs at :56 and again at :00, so it reads `Cron */7 * * * * UTC`. A schedule that `register` refuses throws a `RangeError` and is never read as words: an interval that is not a whole number of milliseconds above 0, a time that is not finite, or a cron expression the parser refuses (`CronRefused`).

## Tests

The suite runs every table case on SQLite through sql.js in memory and, when `AGENTOS_TEST_POSTGRES_URL` names a server, on PostgreSQL; without it the PostgreSQL half shows as skipped under its reason. The repository's CI runs both, PostgreSQL 16 among its services. The cron cases run under UTC and, in `test/cron-tz.test.ts`, under `America/New_York` across its fall-back on 1 November 2026.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions. The first version publishes through the release workflow's npm token, since npm configures a trusted publisher only for a package it holds; every later version publishes through npm trusted publishing, with a provenance statement, once that publisher is configured ([RELEASING.md](https://github.com/framerslab/agentos-extensions/blob/master/RELEASING.md)).

## License

Apache-2.0
