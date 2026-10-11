# @framers/agentos-ext-account-sources

A person's own accounts as sources. This library defines `AccountSourceConnector` and the `SourceRef` every passage carries, with helpers for line ranges, links, bounded body reads and requests under the shared public-sources limiter.

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

## License

Apache-2.0. This pack carries a copy of the repository's license.
