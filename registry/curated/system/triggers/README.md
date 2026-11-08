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
| `createScheduler` | Registration, the restore at start with the missed-run rules, the tick, the lease with a claim token, the fenced settlement, retries, pause, resume, run now, the reads and `forgetActor`. |
| `createSchedulerForTests` | The same scheduler with no interval armed: a host's tests drive `tick()` and `settled()` on their own clock. |
| `migrateTriggers` | Builds `<prefix>_jobs`, `<prefix>_runs`, `<prefix>_missed` and their migration ledger, `<prefix>_schema_migrations`, on PostgreSQL and SQLite. |
| `computeNextRunAtMs` | The next due time of a schedule strictly after a given time, or `undefined` when there is none. |
| `scheduleWords` | The sentence a schedule reads as on a jobs page. |
| The types | `Schedule`, `MissedRunRule`, `JobDefinition`, `RunContext`, `RunSummary`, `JobState`, `RunOutcome`, `JobView`, `RunView`, `MissedView`, `TriggersRefusal`, `TriggersAuditEntry`, `TriggersLogger`, `Keep`, `TriggersOptions`, `Scheduler`, `SchedulerInternals`, `Watcher`. |

`createWatcher` (the stall watcher), `report()` (reports-only rows, which this release answers with nothing) and the retention of runs and missed runs follow in the next pull request of this package. The package stays private until it, and its first version, 0.1.0, publishes with that merge.

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

2. **Build** one scheduler in each process that runs jobs, and one in each process that only reads and commands, which it never starts:

   ```ts
   import { createScheduler } from '@framers/agentos-ext-triggers';

   const scheduler = createScheduler({
     db,                      // the product's StorageAdapter
     prefix: 'trig',
     process: 'sweeper',      // the process word its leases carry
     logger,                  // info, warn, error
     audit: (trx, entry) => writeStaffEvent(trx, entry), // pause, resume and run now, inside the command's transaction
     describe: (error) => ({ kind: errorKind(error) }),  // a failed try's kind as a word
   });
   ```

   `now` (the clock, `Date.now` by default), `tickMs` (10 s by default, the smallest `every`) and `handRunsPerHour` (20 by default) are the other options.

3. **Register** each job before `start()`:

   ```ts
   scheduler.register({
     name: 'ticket_routing',            // a lower-case letter, then at most 63 lower-case letters, digits or underscores
     title: 'Ticket routing',
     process: 'sweeper',
     schedule: { kind: 'every', everyMs: 300_000 },
     rule: 'catch_up_once',             // or 'skip', or 'required'
     safeToRepeat: true,                // offers run now; a lost run is run again
     stallAfterMs: 900_000,
     run: async ({ signal }) => {
       const routed = await routeWaitingTickets({ signal });
       return { did: `${routed} routed` };
     },
   });
   ```

   `register` throws on a name outside the rule, a duplicate name, an `every` below the tick, a cron expression the parser refuses, and a job marked `legalDuty` whose rule is not `required`. `retries` (5), `backoffMs` (30 s doubling to 10 minutes) and `timeoutMs` (10 minutes) take those defaults when left out.

4. **Start** after the product's other registrations, and stop inside the process's SIGTERM grace:

   ```ts
   await scheduler.start();
   process.on('SIGTERM', () => void scheduler.stop({ waitMs: 5_000 }));
   ```

   `start()` writes each definition into its row, restores every job (below) and arms the tick. `stop()` stops claiming (a tick in progress finishes first, and a claim it takes after `stop()` began starts no run and frees the job), holds the lease of each run in flight through `waitMs`, waits up to `waitMs` for those runs and then aborts their signals; a run that settles in the wait releases its lease, and one that does not keeps the held lease until it runs out two ticks after the wait, when the next claim marks it `lost`.

A process that only reads and commands calls `list`, `get`, `runs`, `missed`, `pause`, `resume` and `runNow` on its unstarted scheduler. `pause(name, actor, note?)` and `resume(name, actor)` answer the job's view or a refusal; `runNow(name, actor)` answers `{ queued: true }` or a refusal, and the process that runs the job runs it within one tick. A refusal is `{ refused, status }`: `not_found` (404), `already`, `in_flight`, `not_safe`, `reports_only` (409), and `hand_runs_used` (429, with `retryAt`, the next whole UTC hour), past `handRunsPerHour` hand runs in one UTC clock hour on the instance; two asks at once never both pass the bound. The stall watcher is the step `createWatcher` brings.

## What the scheduler guarantees

- **One run per due time across processes.** A run starts only under a claim: a conditional update that writes the process's lease and a fresh 128-bit token on a job that is due and free. Two processes on one PostgreSQL database give one run per due time; SQLite is one process by the adapter's design.
- **A run that outlives its lease never settles over its successor.** Every write a settlement makes is conditional on its token, so a run whose lease another process took changes no job row; it is left open for that process's claim, which reads it `lost` whenever the first run's body ended. A job not marked `safeToRepeat` is paused by the system after a lost run, never run again on its own.
- **A restart restores every job and loses no row.** Due times that passed while no process ran a job are written to `<prefix>_missed` with cause `worker_down` and follow the job's rule: `skip` records each one skipped; `catch_up_once` records them skipped but the latest, which one run catches up; `required` catches up every one, the run's `covers` naming them. The rows and the move of the job's next due time land in one transaction, and a due time is recorded once whatever number of processes start at once. A catch-up runs on a due time the schedule had, never on "now". A next due time within the last two ticks is left to the claim, never recorded missed, since a process still running the job claims it within a tick. A one-shot first registered after its time is owed at once and follows its rule. A due time whose run's process died holding the lease is never recorded missed: the claim reads that run `lost` first, then runs the due time again or, for a job not safe to repeat, pauses it. Past 1,000 missed due times, `skip` and `catch_up_once` record the newest 1,000 and count the rest in the log line; `required` records the oldest 1,000 and each catch-up's settlement records the next batch.
- **Retries serve the due time their first try served.** A failed try below `retries` waits its backoff and runs again on the same due time, a restart past the backoff included; at the bound the job is paused by the system, reads `failed`, and `onFailed` fires once. `resume` clears it, and records the due times passed while it was paused (cause `paused`) by the job's rule. A resume before the next due time keeps it, and a run claimed before the pause keeps the due time it serves; a run that settles while its job is paused records the due times passed in the pause by the rule, so the resume owes the same catch-up whichever comes first.
- **A changed definition wins over a run in flight.** A run claimed under an older definition settles onto the rule stored by the newest registration and keeps the next due time that registration set, so a rolling restart never writes the old schedule back.
- **A hand run never doubles a run in flight and never runs a job not marked safe.** It leaves the schedule, the tries and a pause as they were.
- **Commands decide by their write.** Each of `pause`, `resume` and `runNow` is a conditional update; two at once on one job give one change and one `already`. The `audit` hook writes inside the command's transaction only after its row changed, and a hook that throws rolls the command back.
- **A timeout is seen at the first tick at or past it**, so a job's `signal` aborts (reason `timeout`) within one tick of its `timeoutMs`, and the try counts as failed when the body settles. The lease is renewed each tick until then.
- **A renewal the database refuses aborts the run's `signal` with `lease_lost` at once**, before another process can take the job.

## What a job body must do

- Honour `signal`: stop its work when it aborts (`timeout`, `lease_lost` or `stop`).
- When it is not safe to repeat, write `runId` and `dueAt` beside its effects, so a run after a lost one can tell what was done.
- Answer `{ outcome: 'failed' }`, or throw or reject (with any value, `undefined` included), for a failed try; `{ outcome: 'skipped' }` when there was nothing to do; `{ did }` for the words the jobs page shows. Words and integers only: never a person's name, address or message.
- Never outlive its timeout.

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
| `{ kind: 'at', at: Date.UTC(2026, 10, 4, 9, 0) }` | Once, 4 Nov 2026 09:00 UTC |

Any other cron expression reads `Cron <expr> UTC`. A minute step reads as an interval only when it divides the hour: `*/7` runs at :56 and again at :00, so it reads `Cron */7 * * * * UTC`. `scheduleWords` throws a `RangeError` for an interval that is not a whole number of milliseconds above 0 or a time that is not finite, and `CronRefused` for a cron expression the parser refuses, so it never reads them as words. `register` checks more (`requireSchedule`: an interval of at least `tickMs`, a finite anchor), so a schedule these words describe, such as `{ kind: 'every', everyMs: 300_000, anchorMs: NaN }` ("Every 5 minutes"), can still be refused there.

## Tests

The suite runs every table case on SQLite through sql.js in memory and, when `AGENTOS_TEST_POSTGRES_URL` names a server, on PostgreSQL; without it the PostgreSQL half shows as skipped under its reason. The repository's CI runs both, PostgreSQL 16 among its services. The cron cases run under UTC and, in `test/cron-tz.test.ts`, under `America/New_York` across its fall-back on 1 November 2026. `test/scheduler.test.ts` drives the tick by hand on a fake clock (`createSchedulerForTests` gives a host the same); its cases that need two processes at once run their calls at once on PostgreSQL and one after the other on SQLite.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions. The first version publishes through the release workflow's npm token, since npm configures a trusted publisher only for a package it holds; every later version publishes through npm trusted publishing, with a provenance statement, once that publisher is configured ([RELEASING.md](https://github.com/framerslab/agentos-extensions/blob/master/RELEASING.md)).

## License

Apache-2.0
