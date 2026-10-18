# @framers/agentos-ext-account-sources

A person's own accounts as sources. This library defines `AccountSourceConnector` and the `SourceRef` every passage carries, with helpers for line ranges, links, bounded body reads, requests under the shared public-sources limiter and the cache lifetime of a read, the contracts, pure rules, PostgreSQL store and coordinator of a durable, resumable synchronization, weighted request quotas that every worker shares, and the fenced purge and revocation recovery of a connection's grant.

Install `@framers/agentos-ext-account-sources` with its peer `@framers/agentos` 0.13.134 or later. Node.js 20.19 or later is required. The runtime dependencies are `@framers/agentos-ext-public-sources` and `@framers/sql-storage-adapter`.

## Connector

An `AccountSourceConnector` exposes its `kind` and four operations:

- `list(selection, signal?)` answers selected `SourceItem`s and `SourceGone` entries.
- `read(item, signal?)` answers a `SourceRead` or a `SourceGone` entry.
- `changesSince(cursor, selection, signal?)` answers changed items, gone items and the next cursor. A null cursor starts a listing.
- `revoke()` ends the access the connector holds where the account supports revocation.

A selection holds account item ids. A read carries text or bytes with a media type, the item and its attribution. A gone item names its id and the reason: `removed`, `no_access` or `not_owned`.

Connectors obtain their grants through AgentOS's auth module and store them through its sealed token store. The connector interface holds no grant. The revocation lifecycle seals a stopped grant's refresh token into its revoke-only queue with the same module's sealing (see [Revocation and purge](#revocation-and-purge)).

## Attribution

`SourceRef` carries `kind`, `title`, `url`, `version` and `readAt` (ISO 8601), with optional `path` and `lines`. An absent address or version is null. The kind is open to later connectors. `isSourceRef(value)` checks the field types and that optional lines form an ordered pair of positive integers; it does not parse dates or authorize an address.

```ts
import { lineRange, sourceRefLink, type SourceRef } from '@framers/agentos-ext-account-sources';

const text = 'one\ntwo\nthree\nfour';
const ref: SourceRef = {
  kind: 'github',
  title: 'Guide',
  url: 'https://github.com/example/example/blob/fake-commit/docs/guide.md',
  version: 'fake-commit',
  readAt: '2026-10-08T12:00:00Z',
  path: 'docs/guide.md',
  lines: lineRange(text, 4, 16),
};
const link = sourceRefLink(ref); // Ends in #L2-L4.
```

`lineRange(text, start, end)` takes valid UTF-16 offsets with an exclusive end and answers 1-based line numbers. CRLF counts as one break. An empty span belongs to the line at its start. `sourceRefLink` adds a GitHub line anchor, replacing an existing fragment; other addresses are unchanged and an absent address stays null.

## Reads and limits

`readCapped(response, maxBytes)` returns a `Uint8Array`. It cancels and throws `ReadCapExceeded` when the declared content length exceeds the cap, before reading, or when the streamed bytes pass it. It reads at most the first chunk past the cap. The error carries `maxBytes`; a response without a body answers an empty array. Pass a finite nonnegative byte cap.

`readThroughLimiter(limiter, call, signal?)` runs a response-producing call under `SourceLimiter`. A 429 or 503 blocks the limiter using `Retry-After`, cancels the response body and throws `LimiterRefused('blocked')`. Other responses are returned for the caller to inspect and consume. A blocked call is refused before it runs.

Share a limiter across callers to the same account source in a process and configure its limits for that source. `SourceLimiter`, `LimiterRefused` and `retryAfterMs` are re-exported unchanged from public-sources. The optional signal cancels admission and waiting; pass it to the fetch inside `call` as well to cancel the request. The limiter holds its slot until `call` and the status check finish; consuming a returned body is the caller's work.

```ts
import { readCapped, readThroughLimiter, SourceLimiter } from '@framers/agentos-ext-account-sources';

const limiter = new SourceLimiter({ concurrency: 3, spacingMs: 250 });

/** Reads a caller-supplied source address under a shared limiter and byte cap. */
async function readSource(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  /** Fetches with the caller's cancellation signal. */
  const call = (): Promise<Response> => fetch(url, { signal });
  const response = await readThroughLimiter(limiter, call, signal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`source returned ${response.status}`);
  }
  return readCapped(response, 2_000_000);
}
```

## Cache retention

```ts
import { decideSourceCache, type SourceCacheDecision, type SourceCachePermission } from '@framers/agentos-ext-account-sources';

/** Decides whether a response whose read began at `readStartedAt` may be stored, and until when. */
function cacheDecision(
  response: Response,
  permission: SourceCachePermission | null,
  readStartedAt: number,
  windowExpiresAt: number,
): SourceCacheDecision {
  return decideSourceCache({
    permission,
    maximumCacheMs: 86_400_000,
    readStartedAt,
    receivedAt: Date.now(),
    windowExpiresAt,
    headers: {
      cacheControl: response.headers.get('cache-control'),
      date: response.headers.get('date'),
      age: response.headers.get('age'),
      expires: response.headers.get('expires'),
    },
  });
}
```

`decideSourceCache(input)` answers `{ kind: 'cache', expiresAt, evidenceId }` or `{ kind: 'skip', reason }`. Its input holds the permission record, the host's maximum lifetime, three times in epoch milliseconds and four response headers; it takes no response body, URL or token.

`permission` is the host's record of an approved retention policy: an opaque `evidenceId` and a `retentionMs`. The library applies the record; it does not establish that a provider allows caching. A missing record, a blank `evidenceId` or a `retentionMs` that is not a positive safe integer answers `not_permitted`, whatever the headers allow.

`expiresAt` is the earliest of:

- `readStartedAt` plus the smaller of `retentionMs` and `maximumCacheMs`, less the response's `Age`;
- `windowExpiresAt`, the end of the retained material's window (the earliest end when a read holds several items);
- the `max-age` and `s-maxage` lifetimes, counted from `receivedAt` and reduced by the corrected age of [RFC 9111, section 4.2.3](https://www.rfc-editor.org/rfc/rfc9111#section-4.2.3): the larger of the age the `Date` header implies and `Age` plus the time the read took;
- the `Expires` lifetime (its distance from `Date`, or from `readStartedAt` when `Date` is absent), counted and reduced the same way, and the `Expires` time itself.

A skip carries one of these reasons:

| Reason | When |
|---|---|
| `not_permitted` | No permission record, a blank `evidenceId`, or a `retentionMs` that is not a positive safe integer |
| `no_store` | `Cache-Control` holds `no-store` |
| `revalidation_required` | `Cache-Control` holds `no-cache`, with or without field names |
| `invalid_cache_header` | A malformed or repeated `Cache-Control` directive; a `max-age` or `s-maxage` without a whole number of seconds or past the safe-integer range; an `Age` that is not a whole number of seconds or is past the safe-integer range; a `Date` or `Expires` before 1970 or outside the IMF-fixdate form of [RFC 9110, section 5.6.7](https://www.rfc-editor.org/rfc/rfc9110#section-5.6.7), exactly as `Date.prototype.toUTCString()` writes it (`Tue, 14 Nov 2023 22:13:20 GMT`) |
| `invalid_bounds` | A clock value that is not a nonnegative safe integer, a `receivedAt` before `readStartedAt`, a `maximumCacheMs` that is not a positive safe integer, or a lifetime past the safe-integer range |
| `expired` | The lifetime ends at or before `receivedAt` |

Directive names match in any case and values may be quoted; a quoted value may hold commas, as in `private="set-cookie, authorization"`. Other directives, such as `private` and `immutable`, neither grant nor extend a lifetime. The obsolete HTTP date forms are refused rather than parsed.

A skip stores nothing: record its reason and keep no content. Store `expiresAt` with the content and check it on every read. Neither a later sync checkpoint nor a second call with the old response extends it; a new read takes a new decision.

## Durable synchronization

```ts
import {
  advanceSourceSyncPage, committableSourceCursor, openSourceSyncCycle,
  type SourceSyncPolicy, type SourceSyncWorkSummary,
} from '@framers/agentos-ext-account-sources';

const policy: SourceSyncPolicy = {
  windowMs: 7 * 86_400_000, maxRetainedDocuments: 100, maxHeldCharacters: 2_000_000,
  maxIndexedCharacters: 4_000_000, scanPageSize: 50, maxScanPages: 4, maxCandidates: 200,
  maxChangedPerLease: 50, maxHistoryPagesPerLease: 10, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};

const opened = openSourceSyncCycle({
  cycleId: 'cycle-1', generation: 3, mode: 'incremental', cutoff: Date.now(), fromCursor: 'cursor-41',
});
const { checkpoint, enqueueIds } = advanceSourceSyncPage(opened, {
  kind: 'history', ids: ['item-a', 'item-b'], nextPageToken: null, cursor: 'cursor-42',
}, policy);
// Store `checkpoint` and queue `enqueueIds` as pending work in one transaction, then read each item.

const summary: SourceSyncWorkSummary = {
  cycleId: checkpoint.cycleId, generation: checkpoint.generation, checkpointRevision: checkpoint.revision,
  total: 2, pending: 0, retry: 0, applied: 1, gone: 1, skipped: 0,
};
committableSourceCursor(checkpoint, summary); // 'cursor-42'
```

A connector that can page through an account adds the optional `sync` capability, an `AccountSourceSyncProvider`, and becomes a `ResumableAccountSourceConnector`. The four original methods keep their signatures, and an empty selection is not redefined as the whole account. The provider's calls take a `SourceSyncRequest` (scope, generation, cycle id, cutoff, policy and an optional signal) and commit nothing: `begin` answers the anchor a cycle starts from, `scanPage` a page of candidate ids, `historyPage` the ids changed since an anchor with the cursor the page reached, and `readSource` one item as a `document`, `gone`, `skipped` or `retry` result. Cursors and page tokens are opaque strings; no rule does arithmetic on them or orders them.

A `SourceSyncDocument` holds a `SourceRead` with text, its message spans as UTF-16 offsets into that text, JSON metadata, an activity time, a content hash and the `cache` decision `decideSourceCache` answered for the read. A `SourceSyncWork` row holds ids, revisions, attempts and a disposition, never content. A `SourceSyncEvent` carries a fixed state, a count and an optional duration, never a scope or a provider payload.

### Connection state

`createSourceSyncState(scope, now)` starts a connection in `not_connected` at generation 0. `transitionSourceSync(state, event, now)` answers the next frozen state. It throws `invalid_source_transition` for an event the state does not allow and `source_sync_counter_exhausted` when a counter would pass the safe-integer range.

| State | Meaning |
|---|---|
| `not_connected` | No grant yet |
| `connecting` | Authorization in progress |
| `syncing` | A sync is running |
| `connected` | Grant held, no sync running |
| `needs_reconnecting` | The grant was refused or lacks a scope; the cursor and use switches are cleared |
| `disconnected` | The connection ended; the cursor and use switches are cleared |

Pause is the `paused` flag on a connected or syncing connection, not a state: it stops syncs and keeps the cursor. Connecting, grant loss, disconnecting, pause, resume, a policy change and a use change each raise `generation`, so a store can refuse work started under an earlier one. A policy change also clears the cursor, so the next cycle applies the new bounds from a fresh pass. Connecting, pause, resume, a policy change, grant loss and disconnecting set `revalidationRequired`; a successful sync clears it. A tune (`policy_tuned`) records a policy whose operating bounds alone changed: in any state it moves `revision` and `updatedAt` and keeps the generation, cursor, `revalidationRequired`, progress and schedule. Disconnecting a disconnected connection, pausing a paused one and resuming an unpaused one answer the same state.

`sourceSyncDue(state, policy, now, trigger)` is false unless the connection is connected or syncing, unpaused and at or after any `retryAt`. A `'scheduled'` trigger is then due once `nextSyncAt` is reached; a `'manual'` one when no request was made yet or `manualMinIntervalMs` has passed since the last. A deferred sync keeps the cursor and sets `retryAt`. A `domain_policy` or `invalid_response` failure clears `nextSyncAt`, so no scheduled sync is due until a manual request or another control change sets it.

### Cycles and the cursor

`openSourceSyncCycle(input)` opens a checkpoint at revision 0 and throws `invalid_source_sync_checkpoint` for an empty or oversized id or anchor, a generation or cutoff that is not a nonnegative safe integer, or an unknown mode. An `incremental` cycle starts with history from the committed cursor; `bootstrap`, `reconcile` and `recovery` start with a scan, and their history then replays from the checkpoint's `fromCursor`: an anchor read before the scan for `bootstrap` and `recovery`, the committed cursor for `reconcile`, or its anchor when the provider answers that the history from that cursor has expired (see [The coordinator](#the-coordinator)). `advanceSourceSyncPage(checkpoint, page, policy)` answers the next checkpoint and the ids to queue, without duplicates:

- A scan that reaches `maxScanPages` pages or `maxCandidates` ids with more left keeps the first ids in the order given, marks the checkpoint `bounded` and stops. A finished scan moves the cycle to history from the same anchor.
- A history page records its cursor as the target. The last page, with no next page token, moves the cycle to `apply`.
- A page of the wrong kind for the phase, a scan page past the bounds or larger than `scanPageSize`, an empty or oversized id, cursor or page token, or a page whose next token is the token it was read with throws `invalid_source_sync_page`.

`committableSourceCursor(checkpoint, summary)` answers the target cursor only in `apply` with no page token left, when the summary names the checkpoint's cycle, generation and revision, holds no pending or retry work, and its applied, gone and skipped counts add up to its total. Otherwise it answers null. `isTerminalSourceWork` is true for applied, gone and skipped work.

The rules are pure and take no lock: the store that commits a cursor reads the summary from all of the cycle's work under its lease and checkpoint lock, in the transaction that commits it. A page carries no gone list: only a read of the item, an exclusion, expiry or the end of the connection removes content.

`new SourceSyncFault(code, retryAt?)` carries a fixed failure code as its message (`source_sync_<code>`), never a provider's text, exposes `code` and `retryAt`, and throws `invalid_source_sync_fault` for an unknown code or a `retryAt` that is not a nonnegative safe integer. `assertSourceSyncPolicy(policy)` throws `invalid_source_sync_policy` unless every policy value is a positive safe integer.

`SOURCE_SYNC_OPERATING_BOUNDS` names the nine policy values that bound how a connection syncs rather than what it keeps: `scanPageSize`, `maxScanPages`, `maxCandidates`, `maxChangedPerLease`, `maxHistoryPagesPerLease`, `leaseMs`, `pollMs`, `manualMinIntervalMs` and `reconcileMs`. `sourceSyncContentChanges(stored, next)` answers every other key whose value differs between two policies, in key order: the window, the retained, held and indexed ceilings, and any key a host adds to the policies it stores, a key only one of them holds included, with values compared as JSON. An empty answer means a tune can store `next`; anything else takes a policy change.

### The SQL store

```ts
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { SqlAccountSourceSyncStore, sourceSyncSchema } from '@framers/agentos-ext-account-sources';

const db = createPostgresAdapter({ connectionString: process.env.DATABASE_URL! });
await db.open();
// The host's migration runs the DDL; the store never does.
for (const sql of [...sourceDerivationSchema(), ...sourceSyncSchema()]) await db.exec(sql);

const store = new SqlAccountSourceSyncStore<PreparedPassages>(db, { bindings });
const scope = { tenantId: 'tenant-1', ownerId: 'owner-1', connectionId: 'connection-1' };
await store.create(scope, policy);
await store.control(scope, { type: 'connect_started' });
await store.control(scope, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
const handle = await store.claim(scope, 'scheduled'); // null unless the connection is due and free
```

`SqlAccountSourceSyncStore` keeps each connection's state, policy, open checkpoint, lease and barrier, the cycle's work rows, the provenance of retained sources and the connection's exclusions in the tables `sourceSyncSchema(prefix)` creates: six statements, with a prefix of a lower-case letter and at most 31 lower-case letters, digits or underscores (`agentos_source_sync` unless given). It needs a PostgreSQL adapter with transactions and runs no DDL. Its `fence` is the core `SqlSourceDerivationStore` on the same adapter, over the tables of `sourceDerivationSchema(derivationPrefix)`: every change to an owner's sources runs under that owner's fence, the one that also commits and delivers results derived from them.

The host supplies seven bindings, and may supply an eighth, `refresh`. The store calls each inside its own transaction, on the transaction adapter it passes:

| Binding | What it does |
|---|---|
| `active(tx, owner)` | Answers false for an account that is deleted or being deleted, whose admission is off or whose purge is pending; the store then claims, commits and reactivates nothing for it and answers no source state |
| `allowance(tx, scope)` | Answers the connection's document and held-character ceilings after unrelated sources, and the remaining indexing balance |
| `write(tx, scope, dependency, document, prepared)` | Writes the document's text and the host's prepared passages and vectors |
| `chargeIndexed(tx, scope, characters)` | Charges the characters a committed write adds to index: a read's whole text, or the text after a held copy's that the read begins with |
| `purge(tx, owner, affected)` | Deletes the host's text, passages and vectors in the affected scope |
| `purgeResults(tx, owner, ids)` | Deletes the host's rows for these derived results |
| `rebind(tx, scope, generation)` | Moves the connection's host rows to a new generation without changing their content, version or expiry |
| `refresh(tx, scope, dependency, document)` | Optional. Moves one source's host rows to the dependency's generation and expiry and the document's message windows, without changing their text, passages or version |

Provider reads, embedding and model calls run between store calls, never inside a binding.

A sync holds a lease. `claim(scope, trigger)` answers a handle only when the owner is active, the `active` binding agrees, no barrier or live lease is set and `sourceSyncDue` holds; `renew(handle)` extends the lease by `leaseMs`; `release(handle, event?)` gives it up, records a deferral or a fixed failure when one is given, and keeps the checkpoint and work for the next claim. `openCycle` opens a checkpoint or answers the one already open, `page` records a page and queues its ids in one transaction (the same page sent again right after answers the same checkpoint; any other stale revision answers null), and `takeWork` marks the next due item attempted before the read; an item that reached five attempts without a recorded result is not taken but waits `pollMs` as a `storage_unavailable` retry. Every call made with a handle checks the owner fence, the lease token and expiry, the generation and the `active` binding in the same transaction; once any of them has moved on, `release(handle)` answers false and every other call answers null.

`applyResult(handle, work, result, prepared)` keeps a `retry` result unresolved. A `document` result is weighed first: the store ranks this connection's retained sources and the new one by activity time, newest first with ties broken by source id, and keeps those inside `maxRetainedDocuments`, `maxHeldCharacters` and the allowance. A document that does not fit is recorded as skipped with `document_limit`, `held_limit` or `indexing_limit`, and an excluded one with `excluded`. A document that fits replaces the source's previous copy in the same transaction (host write, indexing charge and provenance), after that copy and every derived result that depends on it are removed through the fence, and this connection's other sources the limits no longer admit are removed with it, never another connection's. A read that repeats the text and message spans of a copy the store still holds, within its expiry and window, adds nothing to index: it is charged nothing and is not weighed against the indexing allowance, so neither a reconcile that reads every retained source again nor a change to a source's labels or history spends any of it. A read that begins with the text of such a copy, by the hash the store keeps of it, and holds every message of the copy at the same span, as a thread's read does after a reply, adds only the text that follows the copy's: it is charged those characters and weighed against the indexing allowance by them, so a long conversation is charged each reply once rather than its whole text again. A read that changes or drops any of the copy's text is charged in full. When the read also repeats the copy's version and content hash, the `refresh` binding keeps the copy in place, with every result derived from it, and gives it the read's expiry and message windows; otherwise, and for a host without the binding, the copy is written again from a fresh preparation. A `gone` result, a skip and an excluded document remove the source's previous copy, except an `indexing_limit` skip whose previous copy is within its expiry and window, still admitted as it is by the retained limits, and where the new read begins: the read's text starts with the copy's text, by the hash the store keeps of it, and holds every message of it at the same span. That copy, admitted and charged under an earlier read, stays with the shorter of its own and the read's expiry and message windows until a later read of the source finds room in the allowance (a change to it, or a reconcile) or the copy expires; a read that lost or changed one of its messages removes it. A copy past its expiry or window counts as not held, whether or not `expire` has removed it yet. Given `prepared` as null, a document the store has to write answers `pending` with the same handle and records nothing; apply it again with its prepared value. Such a document reaches the `allowance` binding in both calls, so keep that binding to reads. A failing binding rolls the whole application back. The answer carries a new handle whenever a removal advanced the owner's fence; later calls use it. `finish` commits the cycle's target cursor once every work item is terminal, counting from the stored work, and `progress` records the counts so far.

Controls run with the owner blocked, a tune (below) aside. `control(scope, event, policy?)` applies `connect_started`, `grant_ready`, `pause`, `resume`, `use_changed`, `policy_changed` (with the new policy), `grant_lost` or `disconnect`: it records a content-free barrier and drops the open cycle in one transaction, then completes the barrier and reactivates the owner. Connecting, grant loss and disconnecting remove the connection's sources, their derived results and its exclusions. Pause, resume, a use change and a policy change move retained content to the new generation with its version kept and its expiry never extended, so no result derived before the change can be delivered again; a policy change also removes the sources the new limits leave out and shortens the expiry of the rest to the new window. `exclude(scope, sourceId)` removes one source and keeps a content-free exclusion; `resetExclusions(scope)` clears them. Both raise the generation and keep the committed cursor, and make a reconcile the next cycle: a fresh bounded scan, then history replayed from that cursor, so a change made since it reaches the store even for an item the scan does not list. A control other than disconnecting throws `stale_source_sync` while the `active` binding refuses the owner. A barrier left by a failure blocks claims and reactivation until `recoverControl(scope)` completes it, and a lifecycle worker calls it even for a paused connection. `expire(scope, limit)` removes retained sources whose expiry has passed, also while the connection is paused or the owner's fence is inactive, as for a suspended account, which stays inactive, then the owner's expired derived results; reads refuse an expired source either way. Each source goes in a transaction of its own. When a removal or the results' expiry fails, `expire` throws the failure; once it had removed a source, it throws a `SourceSyncExpiryError` with the failure's message and `cause`, whose `partial` counts the removals made before it. `sweepExpired(limit?, owner?)` does the same across every connection, or one owner's, the earliest expiry first and by the store's own expiry, however far a maintenance walk is from them, and answers `{ removed, failed }`: an owner whose removal fails, as when its host purge keeps failing, is counted and left out of the call's later reads, so a call with up to `limit` such owners never holds back another owner's copies. An owner whose derived results then fail to expire is counted too, once; the call still answers every source it removed, and the other owners' results still expire. `removeOwner(owner, remove?)` removes a stopped owner's rows in one transaction: each of its connections, with its work rows, provenance and exclusions, once every one is disconnected with no barrier, lease, work or retained source, after running the lifecycle's own `remove` in the same transaction; the core fence's owner row and deletion records stay, since they hold no content and a restore replays the deletion from them.

```ts
import { sourceSyncContentChanges } from '@framers/agentos-ext-account-sources';

// A release reconciles twice a day where it reconciled daily, and changes nothing a connection keeps.
const stored = (await store.snapshot(scope))!.policy;
const next = { ...stored, reconcileMs: 43_200_000 };
const type = sourceSyncContentChanges(stored, next).length === 0 ? 'policy_tuned' : 'policy_changed';
const after = await store.control(scope, { type }, next); // a tune answers null while a sync holds the lease
```

A tune changes a policy's operating bounds without a reset. `control(scope, { type: 'policy_tuned' }, policy)` stores a policy that differs from the stored one only in `SOURCE_SYNC_OPERATING_BOUNDS`, in one transaction under the owner fence's row lock and the connection's, and changes nothing else: it records no barrier and moves neither the generation nor the owner's epoch, so every lease, fence ticket and derived result stays valid, and the cursor, `revalidationRequired`, progress, schedule, open cycle and retained sources stay as they were, in any state. A connection `readCurrent` answered as connected is still connected, so search and delivery go on. Any other difference throws a `SourceSyncPolicyTuneError` whose `bounds` names the differing keys, as `sourceSyncContentChanges` answers them, and changes nothing: a change to what a connection keeps takes `policy_changed`. The new bounds apply from the next lease. While a lease is live a tune changes nothing and answers null: a sync keeps the policy it claimed its lease with, which a provider may check against the stored one before each request, as Gmail's does. Tune again once that sync ends. A cycle left open between leases goes on under the new bounds, and a scan of it that has already reached a lower `maxScanPages` or `maxCandidates` ends there, as a bounded scan ends, before its history. The next sync stays when it was scheduled, so a new `pollMs` counts from the sync after it. A tune to the stored policy answers the snapshot and changes nothing, and a tune throws `stale_source_sync` while the `active` binding refuses the owner or a barrier is set, which it never completes.

`readCurrent(tx, derivation)` answers the current state of a derivation's sources for the fence's commit and delivery checks, and a connection with a barrier or pending revalidation reads as disconnected. The store's provenance decides a source's expiry: a policy change's prune and an `indexing_limit` skip that keeps a copy shorten it there without calling a binding, so a host that reads its own rows takes the earlier of its row's expiry and the one `readCurrent` answers. `snapshot(scope)` answers metadata for authenticated controls and `documents(scope)` the retained provenance; neither authorizes delivery. Work rows and barriers hold ids and fixed values only. The documents table holds provenance, message timing, counts and hashes, never text. A text hash or a connector's content hash confirms a guessed text, a short templated message most easily, so treat the table as content, like the host's own tables, for access, retention and backups.

### Request quotas

```ts
import { randomUUID } from 'node:crypto';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { readCapped, SourceQuota, sourceQuotaSchema, sourceRetryAt } from '@framers/agentos-ext-account-sources';

const db = createPostgresAdapter({ connectionString: process.env.DATABASE_URL! });
await db.open();
// The host's migration runs the DDL; the quota never does.
for (const sql of sourceQuotaSchema()) await db.exec(sql);

const quota = new SourceQuota(db, {
  policy: {
    projectMinute: 6_000, mailboxMinute: 600, projectDay: 500_000,
    projectConcurrency: 8, mailboxConcurrency: 2, timeoutMs: 15_000, slotGraceMs: 15_000,
    weights: { list: 5, read: 20, changes: 2, profile: 1, labels: 1 },
  },
});

/** One attempt to read an item; a retry calls it again, with a new attempt id. */
async function readItem(url: string, attempt: number): Promise<Uint8Array | null> {
  const scope = { projectKey: 'project-1', mailboxKey: 'mailbox-1' };
  const result = await quota.run({ ...scope, method: 'read', attemptId: randomUUID() }, async (signal) => {
    const response = await fetch(url, { signal });
    if (response.status === 429) {
      await response.body?.cancel();
      return { body: null, retryAfter: response.headers.get('retry-after') };
    }
    return { body: await readCapped(response, 2_000_000), retryAfter: null };
  });
  if (result.kind !== 'completed') return null; // nothing was sent; a deferral or a late start says when to try again
  if (result.value.body === null) {
    await quota.defer(scope, sourceRetryAt(Date.now(), attempt, result.value.retryAfter));
  }
  return result.value.body;
}

// A scheduled job compacts the tables a page at a time, until nothing more is due.
let compaction = await quota.compact();
while (compaction.more) compaction = await quota.compact();
```

`SourceQuota` admits provider requests against weighted budgets that every worker shares through PostgreSQL: a project's rolling minute (`projectMinute`), one mailbox's rolling minute (`mailboxMinute`) and a project's UTC day (`projectDay`). Each budget is a core `SqlSpendMeter` under a table prefix of its own (`<prefix>_pm`, `<prefix>_mm` and `<prefix>_pd`), and at most `projectConcurrency` requests of a project and `mailboxConcurrency` of one mailbox are in flight at once. The quota needs a PostgreSQL adapter with transactions and runs no DDL: the host's migration runs, each with `exec`, the seven scripts `sourceQuotaSchema(prefix)` answers, under a prefix of a lower-case letter and at most 27 lower-case letters, digits or underscores (`agentos_source_quota` unless given). Keys are opaque strings of 1 to 512 characters; a mailbox key stays the same for its mailbox and is never an address. The tables hold keys, counts and times, never content.

`run(request, send, signal?)` decides in one transaction under the project's row lock. An attempt id seen before answers `{ kind: 'duplicate' }`. A recorded provider wait, a full concurrency limit or a budget without room for the method's weight answers `{ kind: 'deferred', reason, retryAt }`, with the wait's own time, the earliest expiry of the slots in the way, 60,001 milliseconds on for a minute budget, or the next UTC midnight for the day; a refusal by one budget rolls back what the others took. Otherwise the transaction consumes the weight in all three budgets and records the attempt's slot, and a second transaction starts the call. An attempt that cannot start within a second of its reservation, after a long wait for the project's lock or a stalled process, answers `{ kind: 'late', retryAt }`: it is retryable with a new attempt id from `retryAt`, a second after the late start was found. Otherwise `run` calls `send` once, outside any transaction, with a signal that aborts after `timeoutMs` or with the caller's signal, then answers `{ kind: 'completed', value }`. Nothing is sent for a duplicate, a deferral or a late start. Units once consumed stay consumed: after a failed request, after a late start, and after a provider wait recorded between the reservation and the call defers the request. A retry is a new `run` with a new attempt id, and pays again. `send` consumes or cancels the response body before it resolves, honors the signal and never retries. The slot frees when `run` finishes, whether it sent or not, or, for a process that dies mid-request, once a second to start, `timeoutMs` and `slotGraceMs` have passed; the attempt id stays refused either way.

`run` throws `source_sync_invalid_response` for a key outside those bounds or a method without a weight, `source_sync_cancelled` when the caller's signal aborted before the call or by the time `send` resolves, `source_sync_network` when `send` resolves after its timeout aborted it, and `source_sync_storage_unavailable` when the store cannot answer. Every worker on the same tables runs the same policy: the first one to use a project records its policy there, and a worker with another policy gets `source_sync_storage_unavailable` too. An error that `send` throws reaches the caller unchanged, unless the store then fails to free the slot.

`defer(scope, retryAt)` records a provider's wait until `retryAt`, in epoch milliseconds, for one mailbox (`{ projectKey, mailboxKey }`) or the whole project (`{ projectKey }`). A shorter wait never replaces a longer one, and every worker honors it, across restarts. `compact()` deletes attempt records a day after their slots expired, mailbox waits that have passed, the meters' reservations settled more than a day ago and the minute budgets' rows idle for a day, at most 1,000 rows of each table a call; the daily totals stay. It answers what it deleted as `{ attempts, mailboxWaits, reservations, windows, more }`: the rows of each kind, with the three meters' reservations counted together and the two minute budgets' rows together, and `more`, true when a table gave a full 1,000 rows. A host calls it on a schedule, and again while `more` is true. Attempt ids must never repeat: once its record is compacted, an old id is no longer refused.

`sourceRetryAt(now, attempt, retryAfter, random?)` answers when a failed request may be tried again, for attempts 1 to 5: `now` plus one second doubled for each earlier attempt, with up to as much again added as jitter (`random`, from 0 to 1, `Math.random()` unless given), capped at 60 seconds. A `Retry-After` value, in delta seconds or an exact IMF-fixdate, wins when it is later, and is never capped; a value it cannot read is ignored. A `now` that is not a nonnegative safe integer, an attempt outside 1 to 5, a jitter outside 0 to 1 or a time past the latest date throws `source_sync_invalid_response`.

### The coordinator

```ts
import {
  AccountSourceSync, sourceSyncCoordinatorSchema, type SourceSyncScope,
} from '@framers/agentos-ext-account-sources';

// The host's migration, after sourceDerivationSchema() and sourceSyncSchema().
for (const sql of sourceSyncCoordinatorSchema()) await db.exec(sql);

const sync = new AccountSourceSync<PreparedPassages>({
  store,     // the SqlAccountSourceSyncStore above
  lifecycle, // purge recovery and the grant-loss handoff: a SourceRevocations (below)
  // Builds the connector bound to this lease; it sends no request while building.
  provider: async (currentHandle) => connectorFor(scope, currentHandle).sync,
  // Embeds outside any transaction; the store commits the result with its document.
  prepare: async (request, document) => embedPassages(document.read.content.text, request.signal),
});

const result = await sync.run(scope, 'scheduled');
// result.kind: completed, idle, yielded, deferred, failed, reconnect, stale or unavailable

// Maintenance, at least once a minute, for every connection.
let after: SourceSyncScope | null = null;
do after = (await sync.maintain(after, 100)).next; while (after !== null);
```

`AccountSourceSync` runs a connection's sync on the SQL store and keeps nothing of its own between calls: the checkpoint, the queued reads, the attempt counts and the retry times are in the store, so any coordinator on the same tables, in this process or another, resumes a run that yielded or stopped. `sourceSyncCoordinatorSchema(prefix)` answers one statement, which adds the nullable JSONB column `operation` to the connections table under the prefix given to `sourceSyncSchema`; run it after that schema, on a new database or an existing one. The store never runs it.

The provider factory receives `currentHandle`, which answers the handle the run holds when it is called; the handle changes after each applied result. The factory builds a provider bound to the lease and sends no request. `prepare` turns a document into the host's prepared value, such as its passages and vectors, outside any transaction, and the store commits that value with the document. The run calls it only for a document the store has to write, so a read the store skips is never prepared, and with the `refresh` binding neither is a read of the copy it already holds. `lifecycle.recover(scope)` completes the host's committed purges; `lifecycle.loseGrant(handle, reason)` receives the run's exact handle, compares it atomically before it fences the grant, so a stale run cannot revoke a newer grant, and answers whether it acted. `runBudgetMs` (90,000 unless given, at most 90,000) bounds one run and `operationTimeoutMs` (30,000 unless given, at most 60,000) one provider call or preparation; another value throws `invalid_source_coordinator_policy`. `clock` and `random` (the retry jitter, from 0 to 1) default to `Date.now` and `Math.random`.

`run(scope, trigger, signal?)` calls `lifecycle.recover` and the store's `recoverControl` for the scope, then claims the lease; a run that claims nothing answers `idle`. With no open cycle it opens one: `bootstrap` when no cursor is committed, `reconcile` once `reconcileMs` has passed since the last cycle that was not incremental or after a change to the exclusions, otherwise `incremental`. A bootstrap, a reconcile and a recovery call the provider's `begin` for an anchor before their scan. A bootstrap and a recovery replay history from that anchor. A reconcile replays it from the committed cursor: history ids only increase, so that replay also covers the changes made between the cursor and the anchor, and a change to an item the bounded scan does not list still reaches the store. Before its scan, a reconcile asks the provider for the first history page from the committed cursor; when that answers `history_expired`, nothing before the anchor can be replayed, so the reconcile replays from its anchor instead, with one scan and one read pass. An incremental cycle replays history from the committed cursor without a scan. A reconcile is also what keeps an unchanged source: it reads every listed source again, and the store charges nothing for the copy it holds, refreshing it in place with the `refresh` binding, but only while it still holds that copy. Set `reconcileMs` below the cache lifetime the connector's reads carry, by more than one poll and the time a reconcile takes; otherwise each copy expires, and `expire` removes it, before the next reconcile reads it again, and it returns as a new admission, charged again.

The run drains the queued reads before it asks for the next page. Each item is read, unless it is excluded, which records it as skipped. The read goes to `applyResult` before any preparation: the store records a skip, or with the `refresh` binding applies a read of the copy it holds, and answers `pending` for a document it has to write, which the run then prepares and applies again. The run goes on with the handle the application answers. When no read is due, a read waiting for its retry time ends the run as `deferred` until then; otherwise the run records the next page, and once the last history page is recorded and every item is terminal, `finish` commits the cursor and the run answers `completed`. A run yields, keeping its checkpoint and reads for the next claim, after `maxChangedPerLease` reads, after `maxHistoryPagesPerLease` history pages, when `runBudgetMs` has passed or when `signal` aborts; a signal aborted before the run starts answers `yielded` at once. It never waits out a retry.

Before each provider call and each preparation the run renews its lease, and the call gets a signal that aborts after `operationTimeoutMs`, at the end of the run budget or a second before the lease expires, whichever comes first. A provider call cut off by that signal counts as a `network` failure and a preparation as `storage_unavailable`; one cut off by the caller's signal yields. The store refuses a result that arrives after the lease, the generation or the owner's fence has moved on, as after a disconnect, and the run then answers `stale`. A failed request is never an empty page, and a bounded scan never proves that an item it did not list is gone.

Attempts are counted before each call, so a process that dies during a call has used that attempt. The anchor read and each page are counted in the connection's `operation` column, under a SHA-256 digest that names the operation, so a new generation, cycle, revision or phase starts a new count; the column holds no page token, cursor or provider id. A reconcile's look at the committed cursor's history shares the count of its anchor read, and a recovery's anchor read continues the count of the history page that answered `history_expired`, so the one column never alternates between two operations, and while a call keeps failing the count reaches five attempts and the `pollMs` wait. Each read is counted in its work row. A `network`, `rate_limited`, `provider_unavailable` or `storage_unavailable` failure records a wait of `sourceRetryAt`: one second doubled for each earlier attempt, with up to as much again as jitter and at most 60 seconds, or the provider's own retry time when that is later. The fifth attempt's wait is at least `pollMs`, and the attempt after it starts a new count of five; five attempts that recorded nothing also wait `pollMs`. The connection's next sync is then that wait, which neither a restart nor a manual request shortens.

A `grant_rejected` or `insufficient_scope` failure goes to `lifecycle.loseGrant` with the run's handle, and the run answers `reconnect`, or `stale` when `loseGrant` answers false. A `domain_policy` or `invalid_response` failure releases the lease with that failure, which clears the next scheduled sync until a manual request or another control sets one, and the run answers `failed`. An unknown exception from the provider becomes `invalid_response`, and one from preparation or storage `storage_unavailable`; no exception text reaches a result or an event. Expired history (`history_expired`) on a history page opens a `recovery` cycle with a fresh anchor and a new bounded scan; a second expiry in the same run defers the sync as `provider_unavailable` for `pollMs`. Retained items the scan does not list stay until they expire.

| Result | When |
|---|---|
| `completed` | The cycle's cursor is committed; carries `examined`, `committed` and `bounded` |
| `idle` | Nothing was claimed: the connection is not due, paused or held by another lease, or the host refused it |
| `yielded` | A budget was spent or the signal aborted; the checkpoint and reads wait for the next claim |
| `deferred` | A retriable failure or a pending retry; carries `reason` and `retryAt`, recorded as the next sync |
| `failed` | `domain_policy` or `invalid_response`; no scheduled sync until a manual request or another control |
| `reconnect` | The grant was refused and `loseGrant` fenced it |
| `stale` | The lease, the generation or the owner's fence moved on; the run committed nothing more |
| `unavailable` | The store could not be reached; no retry time was recorded, and a lease the run held expires on its own |

`maintain(after?, limit?)` is a maintenance batch: for up to `limit` connections after `after`, in key order and in every state, paused, blocked and disconnected included, it calls `lifecycle.recover`, the store's `recoverControl` and `expire(scope, 100)`, after a sweep of up to `limit` sources whose expiry has passed from any connection (`sweepExpired`), so no expired copy waits for the walk to reach its connection; each owner the sweep could not clear, and a sweep that could not read, count in `failed`. A failure is counted in `failed` and the next connection still runs, and the sources an `expire` removed before it failed count in `expired`; no provider is called. It answers `scanned`, `expired`, `failed` and `next`: pass `next` as `after` to the next batch, and start again from null once it is null. Schedule it at least once a minute; reads refuse expired content whether or not it runs.

With an `events` sink the coordinator reports `started` at the claim, `progress` with the count of retained sources after each read, `yielded` and `retry` with the reads made, `succeeded` with the count of retained sources, `reconnect`, and `purged` with the sources a maintenance batch expired. Each event carries `kind`, `state` and `n`, and `yielded`, `retry`, `succeeded` and `reconnect` also the run's duration as `ms`. A sink that throws is ignored.

The coordinator uses three store methods besides those above. `reserveOperation(handle, key)` counts an attempt at the anchor read, a reconcile's look at the committed cursor or a page before it is sent, and answers `{ kind: 'attempt', attempt }`, or `{ kind: 'deferred', reason, retryAt }` while a recorded wait has not passed or after five attempts that recorded nothing. `deferOperation(handle, key, attempt, reason, retryAt)` records the wait after a retriable failure when that attempt is still the one reserved. `pendingRetry(handle)` answers the earliest wait among the cycle's reads.

### Revocation and purge

```ts
import { SourceRevocations, sourceRevocationSchema } from '@framers/agentos-ext-account-sources';

// The host's migration, with the store's and the coordinator's schemas.
for (const sql of sourceRevocationSchema()) await db.exec(sql);

const revocations = new SourceRevocations<PreparedPassages>(db, {
  store,                                     // the SqlAccountSourceSyncStore above
  keys,                                      // SealingKeys: the current key seals, previous keys still open
  values: (tx, scope) => grantRows(tx, scope), // the host's sealed-value rows, on the transaction given
  revoker: (signal) => revocationFlow(signal), // a provider flow without a store; its fetch honors the signal
});
// It is the coordinator's lifecycle binding: new AccountSourceSync({ store, lifecycle: revocations, ... }).

// A disconnect from an authenticated request, at the generation that request saw.
const notice = await revocations.disconnect(scope, generation);
// null when the generation moved on; otherwise { localPending, revocation }

// An account-independent job, at least once a minute.
await revocations.revokeBatch();
```

`SourceRevocations` stops a connection and completes what the stop leaves: the purge of its sources and of every result derived from them, and the revocation of its grant at the provider. `sourceRevocationSchema(prefix)` answers eight statements for the host's migration, under a prefix of a lower-case letter and at most 27 lower-case letters, digits or underscores (`agentos_source_revoke` unless given): the owner's block marker, each connection's stop intent, the revoke-only queue and its due index, the grant lease, and the authorization exchanges with two indexes. No table references an account table, so removing an account cannot erase an outstanding revocation, and the rows hold opaque ids, times, fixed states, attempt counts and sealed refresh tokens only. The service needs a PostgreSQL adapter with transactions and runs no DDL.

The host wires it in four places. The store's `active` binding answers true only when the account is live and `permits(tx, owner)` holds, so an owner whose stop is still purging, or who was deleted, has no sources. Authorization start and grant installation check `canConnect(tx, owner)` under the owner fence. The grant is saved with `new SealedTokenStore(values(tx, scope), keys, { namespace: sourceGrantNamespace(scope) })` under `SOURCE_GRANT_KEY`, the row every lifecycle step reads. A grant operation such as a refresh runs through `withGrant`.

`disconnect(scope, generation)`, `loseGrant(handle, reason)` and `deleteOwner(owner)` each commit in one short transaction the owner's fence, the connection's stop (`disconnected`, or `needs_reconnecting` for a lost grant), a purge barrier, a content-free stop intent, the grant's refresh token moved into the revoke-only queue, sealed under the current key and bound to its queue row, and the deletion of the active grant and its lease. `disconnect` takes the generation the authenticated request saw and answers null for another one; `loseGrant` takes the coordinator's exact current handle and answers false for a stale one; `deleteOwner` stops every connection of the owner, also when there is none, and keeps the owner blocked for good: its block marker stays, recorded as deleted and no longer pending, when `removeOwner` later removes the owner's rows, so `permits` stays false. Call it before the host removes any source, credential or account row. A grant that cannot be opened is deleted all the same, and its queue row records it as unreadable. The purge then runs in a transaction of its own; when it fails, the committed stop keeps the owner blocked, and `recover(scope)` completes it. The coordinator's `maintain` calls `recover` for every connection, paused ones included. None of these methods calls the provider.

`revokeBatch(limit?, signal?)` is the account-independent worker. It claims due queue rows, one worker per row, opens each token and revokes it with the revoker's `revoke` outside any transaction, within 15 seconds. A success confirms the row and erases its ciphertext. A failure is retried after 1, 2, 4, 8 and then 15 minutes, whatever status the provider answered. Each token's deadline is 23 hours and 59 minutes after it was queued, and neither a retry, a restart nor a repeated disconnect or deletion moves it: at the deadline the ciphertext is erased and the row records that the permission must be removed at the provider. A token that does not open, because its ciphertext was moved to another row or its key is gone, is erased the same way and never sent. A worker whose claim expired cannot settle a row another worker claimed since. The batch answers `{ attempted, confirmed, deferred, expired, unreadable }`. The database erases nothing on its own when a deadline passes: reads and dispatch stop at the deadline, and erasure needs the worker to run, so schedule it at least once a minute.

`status(scope)` answers `{ localPending, revocation }`, with `revocation` one of `not_needed`, `pending`, `confirmed` and `permission_removal_required`; the local purge completes whatever the revocation's outcome. A provider can revoke a whole grant rather than one connection's, so `canConnect` stays false while a revocation of the owner's is pending, or expired or unreadable and not yet acknowledged. `acknowledgeRemoval(scope)` records the account owner's statement that the permission was removed at the provider, after which a new grant may begin; it is an attestation, never a confirmation. `compact()` removes, a day after their deadline, terminal rows that nothing refers to. `removeOwner(owner)` removes a deleted owner's rows in one transaction once nothing about them is pending: its connections and their work, provenance and exclusions in the store, and its stop intents, the queue rows they and its exchanges refer to, its grant leases and its exchanges here. It answers `pending`, changing nothing, while the deletion's purge or a revocation of its grants is pending and until a day after its last exchange ended, since a grant can still return for that exchange and must find its record to be queued for revocation; it answers `not_deleted` for an owner whose deletion is not recorded, and `removed` again for an owner already removed. The block marker stays, recording the deletion, so `permits` and `canConnect` stay false and the owner is refused for good, even while the host's account row still reads active; the core fence's owner row and deletion records stay too. `removeDeletedOwners(limit?)` runs it for at most `limit` deleted owners a call, those with rows left to remove and nothing pending, for a host whose own records of a deleted account are gone; run it on a schedule beside `revokeBatch` and `compact`. An owner already removed is not taken again.

`withGrant(handle, work, signal?)` runs one grant operation under a durable 30-second grant lease, without holding a transaction over the network; another worker gets `rate_limited` until the lease expires, and the lease is never renewed. `work` receives a `SealedTokenStore` and a signal that aborts after 15 seconds. Every load and save through that store, and the final return, recheck the sync handle and the lease, so after a disconnect or once the lease has expired a held token can be neither saved nor returned (`grant_rejected`).

```ts
// The callback's transaction consumes the authenticated start and records the exchange, or rolls back.
const exchange = await db.transaction(async (tx) => {
  const start = await consumeStart(tx, callback);
  const begun = start && await revocations.beginExchange(tx, scope, start.generation, start.exchangeId);
  if (!begun) throw new Error('start_refused');
  return begun;
});
// Only after that commit does the code exchange reach the provider.
// When it returns no grant: endExchange(exchange, 'not_dispatched' | 'revoked' | 'unconfirmed').
const grant = await exchangeCode(callback);
const outcome = await revocations.settleExchange(exchange, grant, async (tx, granted) => {
  await new SealedTokenStore(grantRows(tx, scope), keys, { namespace: sourceGrantNamespace(scope) })
    .save(SOURCE_GRANT_KEY, granted);
  await new SqlAccountSourceSyncStore(tx, { bindings }).control(scope, { type: 'grant_ready', use });
  return finishStart(tx, exchange.id);
});
// outcome.kind: 'installed', 'cleanup_pending' or 'permission_removal_required'
```

An authorization code exchange returns a grant before anything is installed, and a cancellation, a disconnect, the account's deletion or a failed installation must not leave that grant at the provider unrecorded. `beginExchange(tx, scope, generation, exchangeId)` runs in the host transaction that consumes the authenticated start. It answers the exchange only when the connection is `connecting` at that generation and `canConnect` holds, so one exchange is in flight per owner; otherwise it answers null, and the host rolls the consumption back. The exchange's row holds opaque ids and times, never a code, a state, a PKCE verifier, an address or a credential. The exchange ends 60 seconds after it begins, and while it is open `canConnect` is false.

`settleExchange(exchange, grant, install)` first seals the grant's refresh token into the revoke-only queue, held there until the exchange ends, so a crash cannot lose it. When `mayInstallExchange(tx, exchange)` holds (this exact exchange is open and before its end, the connection is still `connecting` at its generation with no grant installed, and nothing else keeps the owner from a new grant), `install` runs in the owner's transaction: it saves the grant, records `grant_ready` and finishes the start, and the same commit removes the held token. When the exchange may not install, or `install` answers anything but true, throws or finishes after the end, the whole installation rolls back and the held token is due for revocation at once; after a crash it is due when the exchange ends, and `revokeBatch` revokes it under its own deadline. A grant that arrives for an exchange already recorded as unconfirmed is neither installed nor revoked: a newer grant at the provider could share its permission, so the notice stands.

`endExchange(exchange, outcome)` records an exchange that returned no grant: `not_dispatched` when the request never left the process, `revoked` when the provider flow revoked a grant it refused and the provider confirmed it, and `unconfirmed` otherwise, as after a timeout, an aborted connection or an unreadable answer. An open exchange whose end passes with nothing recorded, because its worker stopped, becomes unconfirmed at the next `revokeBatch`, counted in `expired`. A recorded outcome is never weakened. An unconfirmed exchange, or a returned grant whose revocation expired or could not be opened, makes `status` answer `permission_removal_required` and keeps `canConnect` false until `acknowledgeRemoval`. Exchange rows survive the account's deletion only to settle their attempt. `compact` removes an exchange a day after its end once it installed, ended or was acknowledged, or its returned grant's revocation was confirmed. A deleted owner can never acknowledge, so once the deletion is recorded `compact` also removes the owner's unconfirmed exchanges and those whose returned grant's revocation expired or could not be opened, and their queue rows a day after the rows' own deadline; an exchange still in flight or with a revocation pending stays, and so does the owner's block marker, which keeps `permits` false.

With an `events` sink the service reports `fenced` after a stop's transaction, `purged` after its purge, `confirmed`, `deferred`, `expired` and `unreadable` from `revokeBatch`, and `removed` after `removeOwner` removes a deleted owner's rows, each as `{ kind: 'source_revocation', state, n }`, with no scope, token or provider text. A sink that throws is ignored.

The service uses five store methods besides those above. `stageStop(scope, event, stage, expected)` and `stageOwnerStop(owner, stage)` commit a stop and run the service's writes in its transaction; `completeStop(scope, generation, complete)` runs the purge's completion once the barrier is gone; `withCurrentHandle(handle, work)` runs grant storage work with the handle checked; and `lockState(tx, scope)` reads the connection's state in a host transaction after taking the owner fence's lock and then the connection's.

## License

Apache-2.0. This pack carries a copy of the repository's license.
