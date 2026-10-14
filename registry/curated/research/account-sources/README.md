# @framers/agentos-ext-account-sources

A person's own accounts as sources. This library defines `AccountSourceConnector` and the `SourceRef` every passage carries, with helpers for line ranges, links, bounded body reads, requests under the shared public-sources limiter and the cache lifetime of a read, and the contracts and pure rules of a durable, resumable synchronization.

Install `@framers/agentos-ext-account-sources` with its peer `@framers/agentos` 0.10.40 or later. Node.js 20.19 or later is required. The runtime dependency is `@framers/agentos-ext-public-sources`.

## Connector

An `AccountSourceConnector` exposes its `kind` and four operations:

- `list(selection, signal?)` answers selected `SourceItem`s and `SourceGone` entries.
- `read(item, signal?)` answers a `SourceRead` or a `SourceGone` entry.
- `changesSince(cursor, selection, signal?)` answers changed items, gone items and the next cursor. A null cursor starts a listing.
- `revoke()` ends the access the connector holds where the account supports revocation.

A selection holds account item ids. A read carries text or bytes with a media type, the item and its attribution. A gone item names its id and the reason: `removed`, `no_access` or `not_owned`.

Connectors obtain their grants through AgentOS's auth module and store them through its sealed token store. This library holds no grants and performs no sealing.

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

Directive names match in any case and values may be quoted. Other directives, such as `private` and `immutable`, neither grant nor extend a lifetime. The obsolete HTTP date forms are refused rather than parsed.

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

Pause is the `paused` flag on a connected or syncing connection, not a state: it stops syncs and keeps the cursor. Connecting, grant loss, disconnecting, pause, resume, a policy change and a use change each raise `generation`, so a store can refuse work started under an earlier one. A policy change also clears the cursor, so the next cycle applies the new bounds from a fresh pass. Connecting, pause, resume, a policy change, grant loss and disconnecting set `revalidationRequired`; a successful sync clears it. Disconnecting a disconnected connection, pausing a paused one and resuming an unpaused one answer the same state.

`sourceSyncDue(state, policy, now, trigger)` is false unless the connection is connected or syncing, unpaused and at or after any `retryAt`. A `'scheduled'` trigger is then due once `nextSyncAt` is reached; a `'manual'` one when no request was made yet or `manualMinIntervalMs` has passed since the last. A deferred sync keeps the cursor and sets `retryAt`. A `domain_policy` or `invalid_response` failure clears `nextSyncAt`, so no scheduled sync is due until a manual request or another control change sets it.

### Cycles and the cursor

`openSourceSyncCycle(input)` opens a checkpoint at revision 0 and throws `invalid_source_sync_checkpoint` for an empty or oversized id or anchor, a generation or cutoff that is not a nonnegative safe integer, or an unknown mode. An `incremental` cycle starts with history from the committed cursor; `bootstrap`, `reconcile` and `recovery` start with a scan, from an anchor read before it. `advanceSourceSyncPage(checkpoint, page, policy)` answers the next checkpoint and the ids to queue, without duplicates:

- A scan that reaches `maxScanPages` pages or `maxCandidates` ids with more left keeps the first ids in the order given, marks the checkpoint `bounded` and stops. A finished scan moves the cycle to history from the same anchor.
- A history page records its cursor as the target. The last page, with no next page token, moves the cycle to `apply`.
- A page of the wrong kind for the phase, a scan page past the bounds or larger than `scanPageSize`, an empty or oversized id, cursor or page token, or a page whose next token is the token it was read with throws `invalid_source_sync_page`.

`committableSourceCursor(checkpoint, summary)` answers the target cursor only in `apply` with no page token left, when the summary names the checkpoint's cycle, generation and revision, holds no pending or retry work, and its applied, gone and skipped counts add up to its total. Otherwise it answers null. `isTerminalSourceWork` is true for applied, gone and skipped work.

The rules are pure and take no lock: the store that commits a cursor reads the summary from all of the cycle's work under its lease and checkpoint lock, in the transaction that commits it. A page carries no gone list: only a read of the item, an exclusion, expiry or the end of the connection removes content.

`new SourceSyncFault(code, retryAt?)` carries a fixed failure code as its message (`source_sync_<code>`), never a provider's text, exposes `code` and `retryAt`, and throws `invalid_source_sync_fault` for an unknown code or a `retryAt` that is not a nonnegative safe integer. `assertSourceSyncPolicy(policy)` throws `invalid_source_sync_policy` unless every policy value is a positive safe integer.

## License

Apache-2.0. This pack carries a copy of the repository's license.
