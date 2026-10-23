# @framers/agentos-ext-operations

[![CI Status](https://github.com/framerslab/agentos-extensions/workflows/CI/badge.svg)](https://github.com/framerslab/agentos-extensions/actions)
[![npm version](https://img.shields.io/npm/v/@framers/agentos-ext-operations)](https://www.npmjs.com/package/@framers/agentos-ext-operations)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A product's operations records in its own database, through the SQL storage adapter it already passes: a log table with search, an events table with daily totals over the product's own figures, and the jobs that keep both, every table under a prefix of the product's choosing. This release builds lines, events, the daily totals, the metrics hook, the `fields` rule and the migrations. Support requests, error capture and health checks share the same tables, migrations and rule: their tables exist from this release and their types are exported, and their functions come in the next minor release. Until then each of them throws `not_built` when it is called, never when it is imported.

```ts
import { createOperations, migrateOperations } from '@framers/agentos-ext-operations';

await migrateOperations(db, { prefix: 'ops' });

const operations = createOperations({ db, release: commit, process: 'web', locks: [701, 702, 703], alertsTo: 'team@example.com', logger, mail, routePattern, fields });
operations.start({ shared: true });

operations.lines.push({ process: 'web', kind: 'request', status: 200, path: '/api/notes/[id]', fields: { ms: 41 } });
operations.events.record('note_saved', { plan: 'plus' });

const failures = await operations.lines.search({ status: '5xx' });
const requests = await operations.events.metric('api_requests', 30);
```

## What this release holds

| Part | In this release |
|---|---|
| `migrateOperations` | Builds the fifteen tables on PostgreSQL and SQLite under the product's prefix, with their own migration ledger. |
| `operations.lines` | `push` checks a line against the `fields` rule and queues it; `search` finds lines by kind, path, status, process and time. |
| `operations.events` | `record` checks an event and queues it, its time cut to the hour; `metric`, `funnel`, `retention`, `money` and `today` read the figures; `fill` writes the daily totals of past days. |
| The metrics hook | The product's figures by day and plan, beside the package's own. |
| `start` and `stop` | The flushes in every process; in the process that runs the shared jobs, the nightly totals at 00:20 UTC and the hourly sweep of every retention. `stop()` flushes within 3 seconds and ends the timers. |
| `operations.errors`, `operations.health`, `operations.tickets`, `deleteAccount`, `exportAccount` | Each function throws `not_built` at the call, naming the next minor release. `operations.tickets` is null when `tickets` is left out. |
| `./errors`, `./health`, `./tickets`, `./http`, `./browser`, `./remote`, `./react`, `./worker`, `ops-check` | Each entry imports, and each of its functions throws `not_built` at the call. |

A `not_built` error is an `Error` whose `code` is `not_built`, whose `surface` names what was called, and whose message says that it comes in the next minor release.

## Installation

```bash
npm install @framers/agentos-ext-operations @framers/sql-storage-adapter
```

It needs Node.js 22 or later. Every dependency is an optional peer: `@framers/sql-storage-adapter` (`>=0.7.15`) for the root entry, `./logs` and `./events`. `zod`, `react`, `react-markdown`, `remark-gfm`, `rehype-sanitize` and `sharp` are the peers of the next minor release's entries, and nothing in this release loads them.

## Adopting it in a new product

The steps below are what a product does to take this release. The steps of the full adoption that need the next minor release follow them.

1. **Install** `@framers/agentos-ext-operations` with `@framers/sql-storage-adapter` (`>=0.7.15`; a product on the adapter's 0.6 line moves to 0.7 as an increment of its own first). Pin exact versions.
2. **Migrate.** The product's migration command runs the package's tables first, then its own:

   ```ts
   import { migrateOperations } from '@framers/agentos-ext-operations';

   await migrateOperations(db, { prefix: 'ops' });
   ```

   The prefix is a lower-case letter followed by at most 32 lower-case letters, digits or underscores, so PostgreSQL's 63-byte names hold the longest index name whole; on SQLite, `sqlite` and a prefix beginning `sqlite_` are refused too, since SQLite keeps those names for itself. The prefix is written into every migration's checksum, so a product keeps its prefix for life. The migrations run under the ledger `<prefix>_schema_migrations` and the adapter runner's lock (724313571 unless `lockKey` names another), so the product's own runner and this one never apply at once. Run twice, the second applies nothing. The package's migrations only add, so an older release still starts against newer tables.
3. **Configure** one `Operations` a process, and start the shared jobs in one process alone. The shape for a product with figures of its own:

   ```ts
   const operations = createOperations({
     db,
     prefix: 'ops',
     release: commit,
     process: 'web',
     locks: [lockTick, lockSweep, lockTotals],
     alertsTo: 'team@example.com',
     logger,
     mail,
     routePattern,
     fields: {
       status: { kind: 'integer' },
       ms: { kind: 'integer' },
       kind: { kind: 'word', words: ['request', 'error', 'job'] },
       session: { kind: 'id' },
       path: { kind: 'path' },
     },
     metrics: { plans, metrics: { signups, minutes }, excluded },
   });
   operations.start({ shared: true });
   ```

   `locks` are three distinct integers, the tick's, the sweep's and the totals': on PostgreSQL each shared job runs in a transaction that first asks `pg_try_advisory_xact_lock` for its number, so a second process skips a run rather than waiting for it; on SQLite the locks are skipped. This release runs the sweep and the totals, and the tick comes with health. Every other process calls `operations.start({ shared: false })`, which runs its flushes alone; a later `start({ shared: true })` arms the shared jobs, and a later `start({ shared: false })` leaves them running. `logger` is any object with `info`, `warn` and `error` (AgentOS's `ILogger` is one). `routePattern(pathname)` answers the pattern of the product's route for a path, or null. `release`, `alertsTo` and `mail` are checked when the operations are created, and this release reads none of them: the error capture, the alerts and the replies of the next minor release do. `limits` overrides the defaults below, and `now` gives the jobs and the written times a clock other than `Date.now`.

   The short shape, for a product with no figures of its own (a runtime, a worker, a command), leaves `metrics` out: the Analytics views answer the package's own figures alone. Leaving `tickets` out, as both shapes here do, makes `operations.tickets` null.
4. **Declare the fields** the product's log lines and events may carry, before any line is pushed: a closed list of keys, each an integer key, a word key with its words, an id key (32 hexadecimal characters) or `path`, which holds a route pattern that the product's `routePattern` answers with itself, or the word `unknown`. The package refuses every other key or value, a nested object and an array, and counts the refusals into one `ops_refused` line a key a minute through `logger`, naming a declared key or `unknown`, never the value. A declared key whose value is `undefined` is left out, as JSON leaves it out. A logger whose lines are free text pushes nothing until its lines are objects under this rule.
5. **Push and record.** Hand each of the product's checked log lines to `operations.lines.push` and each event to `operations.events.record`. Neither throws nor waits: each queues, and the queue flushes every 5 seconds once `start()` has run, or at once at 500. A line's `kind`, `status` and `path` are columns, checked under the product's rule when it declares those keys (a value the rule admits must still fit its column: text for `kind` and `path`, a whole number for `status`), else as a word, an HTTP status and a route pattern, and its other fields go under the rule. An event's `plan` is one of the product's plan words (any word when `metrics` is left out) or `none`, its `n` a whole number of 0 or more, and its fields hold no id key, since an event names no one. Call `operations.stop()` from the server's `SIGTERM` listener, and give the container a stop grace long enough for its 3 seconds.
6. **Metrics.** Give each figure of the product's own as a function of the day's bounds and the excluded accounts, answering rows of `{ plan, value }` with the product's plan words, `none`, or `all` for a figure that splits by no plan. `all` is refused in `plans`, since the totals write the sum over the plans under it. A value is a number: PostgreSQL's driver answers `COUNT(*)` as a string, so the hook converts it.

   ```ts
   import type { OpsMetric } from '@framers/agentos-ext-operations';

   const signups: OpsMetric = async (db, dayStartMs, dayEndMs, excluded) => {
     const left = excluded.length === 0 ? '' : ` AND id NOT IN (${excluded.map(() => '?').join(', ')})`;
     const rows = await db.all<{ plan: string; value: number | string }>(
       `SELECT plan, COUNT(*) AS value FROM accounts WHERE created_at >= ? AND created_at < ?${left} GROUP BY plan`,
       [dayStartMs, dayEndMs, ...excluded],
     );
     return rows.map((row) => ({ plan: row.plan, value: Number(row.value) }));
   };
   ```

   A figure split by a second word (sessions ended by reason) is one metric a word, `<metric>_<word>`. An entry `{ count, losesDeleted: true }` marks a figure whose source loses deleted accounts, `{ count, fillsBack: false }` one whose source has no history before the landing, and `source` names where it comes from. `excluded(db)` answers the staff and test account ids the figures leave out. `funnel` names four metrics in order, and `retention(db, weekStartMs, excluded)` answers one sign-up week's cohort. The package reads its own figures from its tables and nothing from the product's.
7. **Fill.** Once, at the landing, call `operations.events.fill(90)` to write the totals of the last 90 days from every source that keeps its history: only the days and metrics with no row yet, the package's own figures from the day its tables were made, and no entry marked `fillsBack: false`.
8. **Read.** Call `operations.lines.search(query)` and the five views inside the product's own staff routes, after its own permission check: this release checks no permission itself. `OpsPermission` names the eight permissions of the full package, and `logs.read` and `analytics.read` are the two these reads map to.
9. **Privacy.** Say on the product's privacy page what this release keeps and for how long: a copy of the checked log lines for 14 days, events counted by hour and plan for 90 days, and daily totals for two years. None of them names a person.
10. **Tests.** Add the product's own end-to-end journey of a line pushed and found by search, and an event recorded and read back in the views after the nightly totals or a fill.

With the next minor release, the full adoption adds: the support tables tied to the product's accounts (a foreign key migration on PostgreSQL, `operations.deleteAccount` inside the account deletion's transaction elsewhere); the eight permissions given to the product's staff roles; the capture of route failures, `onRequestError`, `uncaughtExceptionMonitor`, `unhandledRejection` and browser failures; `./http`'s handlers mounted with the product's `person` and `staff`; the person's and staff's pages over `./react`; the categories and `OpsWords` in the product's voice; the branded reply mail, the identity notice and the team alert through `mail`, and `notify`; requests, pictures and error records on the privacy page; `ops-check` on a second machine and `./worker` on an edge cron; and the tests of a request, a reply, a failure and a deletion.

## The entries

| Entry | What it exports |
|---|---|
| `@framers/agentos-ext-operations` | `createOperations`, `migrateOperations` and every type of the contract (`Operations`, `OpsOptions`, `OpsFields`, `OpsMetric`, `OpsMetricsHost`, `OpsLineInput`, `OpsSearch`, `OpsLogPage`, `OpsEventInput`, `OpsMetricSeries`, `OpsFunnel`, `OpsRetention`, `OpsMoney`, `OpsToday`, `OpsLimits` and the shapes of the next minor release's surfaces). |
| `./logs` | `createLines`, the factory behind `operations.lines`; a product reaches lines through `createOperations`. |
| `./events` | `createEvents`, the factory behind `operations.events`; a product reaches events through `createOperations`. |
| `./errors` | `createErrors`: throws `not_built`. |
| `./health` | `createHealth`: throws `not_built`. |
| `./tickets` | `createTickets`: throws `not_built`. |
| `./http` | `createHandlers`: throws `not_built`. |
| `./browser` | `installReporter` and `reportError`: each throws `not_built`. |
| `./remote` | `createRemote`: throws `not_built`. |
| `./react` | `useRequests`, `useRequest`, `useStream`, `useComposer`, `useStaffList`, `useStaffRequest` and `Markdown`: each throws `not_built`. |
| `./worker` | `createEdgeWatcher`: throws `not_built`. |
| `ops-check` | The command of the second machine's watcher; it ends with the `not_built` error. |

## Lines and the search

`lines.push({ process, kind, status?, path?, fields? })` keeps one line shape (process, kind, status, path) at most 60 times a minute; past that it counts the lines and writes one `ops_rate_cut` line with the count at the minute's end in their place, and the request figures add the counts back. `lines.search({ kind, path, status, process, from, to, cursor })` matches `kind` exactly (one or several, at most 20; a longer list throws a `RangeError`), `path` as a prefix and `status` as one code or a class from `2xx` to `5xx`, over the last hour unless `from` and `to` say otherwise, 14 days at most (an older `from` is cut to 14 days), newest first, 100 lines a page, with a cursor of time and id for the next page. Pass `from` and `to` with the cursor, since the default window moves between calls.

## Events and the figures

`events.record(kind, { plan, n, fields })` writes one row to the events table with its time cut to the UTC hour. The nightly totals at 00:20 UTC write the day before into the daily table, one row a metric and plan with `all` as their sum; each metric counted replaces its rows of that day, so a run repeated writes the same rows; today's figures are counted live by the same functions. A hook that throws for one metric writes one `ops_job` line naming the metric, and the rest land. A process that is down at 00:20 UTC writes no row for that day: the `ops_totals` beat shows the gap, and `fill` writes the missing days.

The package's own figures: `api_requests` and `api_errors` (the product's log lines of kind `request`, and those that answered 5xx), `errors` with `errors_server` and `errors_browser`, `requests_opened` and `requests_open`. The last five read the tables the next minor release fills, and count 0 until then.

| View | Answers |
|---|---|
| `metric(name, 30 \| 90)` | One metric's days by plan, its source (`own` or `host`), the source's name and whether it loses deleted accounts. |
| `funnel(30 \| 90)` | The four steps of `metrics.funnel` by week. |
| `retention(30 \| 90)` | Each sign-up week's cohort from `metrics.retention`, a week not yet over as null; nothing of it is stored. |
| `money(30 \| 90)` | The product's `purchase_amount`, `topup_amount` and `cost` metrics by day, in its micro units. |
| `today()` | The home row's counts: requests waiting, error groups first seen today, checks failing, sign-ups today and requests resolved today. |

## The shared jobs

| Job | When | What |
|---|---|---|
| `ops_totals` | 00:20 UTC | The day before's totals, under the totals lock. |
| `ops_sweep` | 40 minutes past each hour | Every retention below, at most 1,000 rows a statement until a statement removes fewer, each statement in a transaction of its own that first tries the sweep lock. A retention whose statement fails writes one `ops_job` line naming it and the rest still run. |

Each job writes its beat to the beats table after each run (`ok`, `failed` or `skipped`, with the time of its last run that landed whole), so a stalled job shows. The sweep runs whenever the tables exist, whatever the product's own switches say.

## Limits

| Limit | Default | What it bounds |
|---|---|---|
| `lineQueue` | 5,000 | Lines waiting for a flush; past it the oldest go and are counted on one `ops_flush` line. |
| `eventQueue` | 5,000 | Events waiting for a flush, the same way. |
| `lineShapePerMinute` | 60 | Lines of one shape kept a minute before the rate cut. |
| `captureQueue`, `beatQueue`, `occurrenceEveryMs`, `browserGroupsPerDay` | 2,000, 500, 10,000, 500 | The error capture and the beats of the next minor release. |
| `ticketsPerDay`, `ticketCooldownMs`, `messagesPerHour`, `subjectMax`, `bodyMax`, `picturesPerMessage`, `picturesPerTicket` | 5, 30,000, 30, 200, 5,000, 3, 10 | Support requests, in the next minor release. |
| `streamsPerAccount`, `streamsPerProcess`, `streamLifeMs` | 3, 50, 900,000 | A request's live stream, in the next minor release. |
| `pictureBytesMax`, `pictureInputPixelsMax`, `pictureLongSideMax`, `pictureOutputBytesMax`, `pictureWaitMs` | 5,242,880, 50,000,000, 2,000, 1,048,576, 10,000 | Pictures, in the next minor release. |
| `mailUnreadMs`, `mailGapMs`, `exportsPerDay` | 300,000, 1,800,000, 3 | Mail to people and the export, in the next minor release. |

A batch that fails whole while the database is away goes back in front of its queue for the next flush; a row the database refuses alone is lost alone and counted. Every limit is checked when the operations are created: an unknown key or a value that is not a whole number of 0 or more throws a `TypeError` naming it.

## Privacy

| Table | Holds | Kept |
|---|---|---|
| `<prefix>_log_lines` | The checked lines; an id only under a key the rule declares as one. | 14 days |
| `<prefix>_events` | A kind, a plan, a count and fields of words and integers, the time cut to the hour; no id. | 90 days |
| `<prefix>_daily` | Daily totals by metric and plan. | Two years |
| `<prefix>_beats` | Each shared job's last run and outcome. | Current |
| The support, error and health tables | Nothing in this release. | Their retentions already run: a request a year after it closed, with its messages and pictures; pictures 90 days after their request closed; an error group 90 days after it was last seen; occurrences 30 days; health samples 14 days; outages two years. |

The package's own lines (`ops_flush`, `ops_job`, `ops_refused`, `ops_rate_cut` in this release) carry a fixed word with words and integers, never a sentence and never an id.

## The watchers

`ops-check` on a second machine and `./worker` on an edge cron, each beating so a stopped watcher shows, come in the next minor release with health.

## Tests

The suite runs every case on SQLite through sql.js in memory and, when `AGENTOS_TEST_POSTGRES_URL` names a server, on PostgreSQL; without it the PostgreSQL half shows as skipped under its reason. The repository's CI runs both, PostgreSQL 16 among its services. Fixture tests feed an address, a sentence, a token, a sign-in link and an error's sentence through every entry this release builds and find none of them in a table outside the support tables or in the package's own lines.

## License

Apache-2.0
