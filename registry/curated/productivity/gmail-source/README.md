# Gmail source

This library provides read-only Gmail authorization on the AgentOS redirect grant and sealed-token contracts, text helpers that sanitize and trim mail before it is stored (see Text ingestion below), a bounded mapper that turns one thread response into a sanitized source document (see Thread documents below), a capped read-only API client that sends every call through the host's quota and grant services (see Read-only API below), and a connector that binds them to durable account-source synchronization (see Connector and durable synchronization below). It requests the sole Gmail read-only scope, offline access and incremental consent. It exports no send, reply, label-modification or attachment-download tool.

Install it next to `@framers/agentos` 0.13.146 or later, whose HTML loader strips tags in linear time, and `@framers/agentos-ext-account-sources` 0.7.0 or later. Both are peer dependencies with a floor and no upper bound. Node.js 20.19 or later is required.

```ts
import { GmailOAuthFlow } from '@framers/agentos-ext-gmail-source';

const callback = 'https://app.example.com/sources/gmail/callback';
const client = { clientId, clientSecret, redirectUris: [callback] };

// The request that sends the person to Google: keep the state and the verifier in a short-lived, single-use record.
const begun = new GmailOAuthFlow(client, null).begin({ redirectUri: callback });

// The request Google sends the person back to. `store` is a SealedTokenStore under the connection's namespace.
const flow = new GmailOAuthFlow(client, store);
const grant = await flow.complete({
  code,
  state,
  expectedState: begun.state,
  codeVerifier: begun.codeVerifier,
  redirectUri: callback,
});
// After the host has consumed the start and rechecked the account: the store receives the refresh token and scope.
await flow.keep(connectionId, grant);
```

Construct `GmailOAuthFlow(client, store, options)` on the server. `client` contains the dedicated client id, client secret and exact registered callback URI list. Load credentials through the host's secret mechanism. The default endpoints are Google's HTTPS endpoints. Endpoint overrides are restricted to CI stand-ins; never derive them or callback URIs from a browser request.

`begin({ redirectUri })` returns the authorization URL, state and PKCE verifier. Keep state and verifier under a short-lived, single-use record tied to the signed-in account. `complete(input)` checks state, exchanges the code and verifies the granted scope and refresh material. It returns credentials in memory and does not persist them. The host must atomically consume the start and recheck account liveness and generation before installing the sealed grant. Do not log callback URLs, credentials or errors from arbitrary provider middleware.

Construct a flow for each scheduled token operation, with that operation's sealed store and abort signal, call `accessToken`, and discard the flow at the end of the operation. A store scoped to one operation must never be retained for another worker. The host's durable lifecycle owns disconnect, purge, refresh exclusion across workers and revocation. `forget` on an independently held flow is not a cross-worker lifecycle operation. `accessToken` checks the read-only scope, before Google is asked, on the grant its own call read in the key's turn, the one a refresh renews, so neither another writer between two reads nor calls for other keys can change its outcome; a token held in memory is used only while the store holds the grant it came with, refresh token and scope alike.

OAuth responses are capped at 65,536 bytes and must finish within 15 seconds. An answer past the cap is refused at once: the rest of Google's stream is cancelled without waiting for the cancellation to settle, and the Gmail API's answers are read the same way. Parent cancellation stops dispatch and body consumption. `revoke(token)` resolves when Google revokes the token, and when Google answers that the token is already expired or revoked: Google answers such a token with 400 and `invalid_token`, where RFC 7009 section 2.2 answers 200, and either way the token no longer works. So the revoke-only queue confirms the revocation of a grant the person already removed at Google rather than retrying it to its deadline and then asking for a permission removal. Revoke a grant's refresh token to end the grant: Google answers an expired access token the same way while its refresh token stays valid. Every other answer that is not a success throws `OAuthGrantRefused` with reason `revoke`. Fixed `GmailOAuthFault` reasons contain no provider message or credential. When an exchange succeeds and `complete` does not return the grant, because the grant fails the checks or because the parent cancelled before `complete` returned, the flow asks Google to revoke the grant before it throws. That revocation has the same byte cap and a 15-second deadline of its own, and the parent's cancellation does not stop it. The fault's `cleanup` field then reads `confirmed` or `unconfirmed`; Google's answer that the grant is already expired or revoked reads `confirmed`. An unconfirmed outcome needs a provider-permission removal instruction. It does not authorize retaining the grant.

The host supplies informed consent, cache permission, retention policy, account isolation and a truthful availability state. Authorization alone does not establish permission to store or send mailbox content to a model. Do not infer those permissions from this package's successful tests.

Protocol references: https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/workspace/gmail/api/auth/scopes.

## Text ingestion

```ts
import { messageText, sanitizeMailHeaders, sanitizeMailMetadata } from '@framers/agentos-ext-gmail-source';

const policy = { maxInputCharacters: 2_097_152, maxLineCharacters: 65_536, maxOutputCharacters: 20_000 };

// Strings the host's MIME reader has already decoded within its byte and structure bounds.
const headers = sanitizeMailHeaders(decodedHeaders, policy); // { subject, date, from, to, cc }
const body = messageText(decodedPlainText, policy);
const filename = sanitizeMailMetadata(decodedFilename, { ...policy, maxOutputCharacters: 200 }).text;
// body.text is sanitized and trimmed; body.trimmedQuote, body.trimmedSignature and body.truncated report omissions.
```

`sanitizeMailText(input, policy)` removes address tokens and credential-shaped content without a network call. `sanitizeMailMetadata` applies the same rules and folds whitespace for filenames, label names and display fields. `sanitizeMailHeaders` retains only Subject, Date, From, To and Cc; its Subject output is capped at 200 characters. MIME header decoding and structural validation must happen before these functions receive strings. Bcc is never returned.

`policy` supplies `maxInputCharacters`, `maxLineCharacters` and `maxOutputCharacters` as positive UTF-16 code-unit counts. The input ceiling is 2,097,152 and the line ceiling is 65,536. The output cap cannot exceed the input cap. Oversized input throws `GmailTextFault` with a fixed reason; an overlong line is suppressed. Processing never scans only a truncated prefix for credentials. Percent and character-reference decoding repeats at most four times, every named reference of the HTML standard and numeric references among them; a line that still holds an encoded byte or a known reference after those passes is removed. Padding, a run of spaces and invisible characters that holds anything other than ASCII spaces and tabs, such as the no-break spaces, zero-width non-joiners, combining grapheme joiners and braille blanks mail templates repeat after a preheader, becomes one space, or nothing when it holds no space at all, so zero-width characters between letters join them. Padding that holds an invisible character and ends a line leaves no space there; a run of no-break spaces alone keeps one, so a signature separator written with one still reads `-- `. Runs of ASCII spaces and tabs stay as written. Output truncation avoids splitting a surrogate pair and is marked in the result.

`messageText(input, policy)` sanitizes first, trims recognized reply history and short signatures, then applies the output cap. Explicit forwarded content and ambiguous prose are retained. Its `trimmedQuote`, `trimmedSignature` and `truncated` flags describe omissions. Quote spans must refer to its returned string, without inserted summaries or an ellipsis presented as source text. A host should disclose that attachments are listed and their contents are not read when its mapper implements that boundary.

The functions return text and counts only. They do not store raw values or a reverse-redaction map, log matches, fetch URLs, interpret mail as instructions or invoke a model. Sanitization can remove benign text and cannot identify every possible secret. It does not make personal mail anonymous or authorize model processing, sharing or retention. Hosts must preserve the source's privacy, expiry and deletion rules for both text and derived results.

## Thread documents

```ts
import { GmailThreadMapper } from '@framers/agentos-ext-gmail-source';

const mapper = new GmailThreadMapper({
  maxResponseBytes: 2_097_152, maxDecodedBytes: 2_097_152, maxMimeDepth: 20, maxMimeParts: 1_000,
  maxMessages: 100, maxMessageCharacters: 20_000, maxThreadCharacters: 200_000,
  maxMetadataCharacters: 200_000, maxInputCharacters: 2_097_152, maxLineCharacters: 65_536,
  maximumCacheMs: 86_400_000,
});

// `response` is the parsed threads.get (format=full) body from a transport that capped its bytes.
const result = await mapper.map(response, {
  sourceId: response.id,
  sourceDetailUrl: detailPath, // the host's authenticated source-detail route, never a Gmail link
  cutoff, windowMs: 30 * 86_400_000, readStartedAt, receivedAt,
  permission, cacheHeaders, labelNames, labelCache, signal,
});
// result.kind is 'document' (text, message spans, metadata, cache expiry) or 'skipped' with a fixed reason.
```

Construct `GmailThreadMapper(bounds)` with explicit response, decoded-byte, MIME depth/part, retained-message, message/thread text, metadata, sanitizer and cache ceilings. `map(thread, options)` returns the account-source `SourceSyncReadResult` union. The input is the parsed response from a transport that already enforced its byte cap before JSON decoding. The mapper separately checks recognized MIME data and the entire part tree before decoding any selected body. A parsed object alone cannot establish its original wire size.

Supply a fixed selection cutoff, message window, original read start and completion times, actual response cache headers, independently established cache permission and a host-generated relative detail path. The path must resolve authentication and current source generation in the host. It is never a Gmail deep link or a request-derived external URL. A successful OAuth grant does not establish cache or model-processing permission.
Pass `labelCache` as the separate labels response’s cache decision. Missing, refused or expired label permission keeps ids without names. Permitted names shorten the entire document’s expiry when their allowed lifetime ends first.

Each message is filtered by its internal timestamp, the excluded labels (spam, trash and drafts) and the `excludedCategories` option: a message carrying an excluded category's label (`CATEGORY_PROMOTIONS` for `promotions`, and so on) is left out and counted under `excluded_category`; none is excluded by default. Retained messages are selected newest first with stable id ties, within the explicit cap, and rendered chronologically. Plain text wins within a MIME alternative. Other multipart containers retain their non-attachment text children in MIME order. HTML uses the public AgentOS `HtmlLoader` with an in-memory Buffer; every character reference the loader leaves is then decoded, padding collapses and whitespace collapses again, with at most one blank line between paragraphs. No browser or remote resource is loaded. The resulting text, structured headers, filenames, media types and label names all pass the text sanitizer.

Attachments are listed; their contents are not read. An external body or attachment contributes only sanitized filename, media type and size. Inline attachment bytes and attachment ids are discarded. Bcc, raw payloads, snippets and unknown fields are not returned. The mapper never calls any Gmail endpoint. Unsupported charset, invalid bytes and omitted content have fixed counted reasons. Invalid protocol shape is a failure rather than an empty successful source.

A returned document has matching item/ref versions, a normalized-content hash, message ids and body spans, earliest allowed expiry and explicit omission/truncation metadata. Spans count UTF-16 code units in the returned text and exclude the header prefix. Quote trimming preserves normalized source text; no generated summary or ellipsis is inserted into a quote. Header-only messages can have an empty body span. Render structured metadata as escaped text and treat all mail as untrusted data.

The version is the thread's history id and `contentHash`, the SHA-256 of the normalized text, metadata and message spans, so the hash is the field that carries a change to how text is normalized. A release that normalizes text differently changes the hash of exactly the threads whose normalized text, metadata or spans it changes. At the next read of such a thread, when history names it or a reconcile scan lists it, the account-source store finds a new version and writes the copy again. A thread whose history id, normalized text, metadata and message spans (each message's window end among them, so a changed `windowMs` changes the version too) are unchanged keeps its version, and the store, given a host's `refresh` binding, keeps that copy in place without embedding it again. No separate normalizer version is kept.

A history-only change does not extend cache life or change the normalized hash. Storage still requires the account-source transactional fence, fresh expiry checks and host allowances. Derived results retain the whole source's personal-use, expiry and deletion restrictions. Never persist the transient MIME types or bypass the account-source store with a mapper result.

## Read-only API

```ts
import { GmailApi } from '@framers/agentos-ext-gmail-source';

// `revocations` is the host's SourceRevocations and `quota` its SourceQuota, on the tables its coordinator uses.
const api = new GmailApi({
  client, revocations, quota,
  currentHandle: () => handle, // the sync handle that holds this connection's lease now
  projectKey: 'project-1', mailboxKey, // a stable keyed hash for the mailbox, never its address
  bounds, // the thread mapper's bounds (see Thread documents)
  limits: { timeoutMs: 15_000, maxLabels: 1_000, maxHistoryReferences: 10_000, maxPageTokenCharacters: 4_096 },
});

const profile = await api.profile(signal); // compare profile.emailAddress privately; keep profile.historyId
const labels = await api.labels(permission, signal);
const page = await api.list(cutoff, 30 * 86_400_000, 100, null, signal); // { kind: 'scan', ids, nextPageToken }
for (const id of page.ids) {
  const result = await api.readThread(id, {
    cutoff, windowMs: 30 * 86_400_000, sourceDetailUrl: detailPath(id), permission, labels, signal,
  });
}
const changes = await api.history(profile.historyId, 100, null, signal); // { kind: 'history', ids, nextPageToken, cursor }
// A failure is a SourceSyncFault with a fixed code and, for a wait, the time to try again in retryAt.
```

`GmailApi(options)` uses the account-source quota and grant services supplied by the host. Pass a live `currentHandle` getter, stable opaque project/mailbox quota keys, the dedicated OAuth client, mapper bounds and explicit transport limits. The client constructs each OAuth flow inside the grant service's callback. It retains no flow or sealed-store callback between operations. Production uses fixed Google origins and only profile, labels, threads list/get and history list. CI may configure loopback or reserved fixture origins; HTTP redirects and arbitrary paths are refused.

`profile(signal?)` returns a server-memory address and history id for private account binding. Never store its address in a source or log it. `list(cutoff, windowMs, pageSize, pageToken, signal?)` returns a bounded scan page. The query uses epoch seconds and excludes spam, trash and drafts; exact message eligibility remains the mapper's responsibility. `history(fromCursor, pageSize, pageToken, signal?)` returns deduplicated changed thread ids and the string response cursor. The host must persist pending work and commit a terminal cursor only after all work has completed. Neither method claims mailbox-wide completeness.

`excludedCategories` names the inbox tabs to leave out, by their `category:` search names (`promotions`, `social`, `updates`, `forums`; none by default): the scan query carries `-category:<name>` for each, a history record that adds a message whose labels carry the category (`CATEGORY_PROMOTIONS` and so on) names no thread to read for that addition (a deletion or a label change still does), and the mapper leaves such messages out of the copy under `excluded_category`. A message that moves between two excluded tabs does not change the copy, so a mailbox whose tabs churn is not re-read for mail the host never shows. A host that keeps the Primary tab alone passes `GMAIL_CATEGORIES`, the four names. The names and labels are Google's: the search operators at https://support.google.com/mail/answer/7190 and the system labels at https://developers.google.com/workspace/gmail/api/guides/labels.

`labels(permission, signal?)` returns sanitized names and the cache decision from that labels response. A refused decision contains no names. `readThread(sourceId, options)` accepts cutoff/window, a trusted private detail path, cache permission, the independent label snapshot and optional signal. It passes the actual thread response headers and times to the mapper and returns only the account-source read-result union. It never returns raw MIME. A labels response cannot borrow a thread response's longer cache lifetime.

One provider operation makes one attempt, with one fresh-token retry permitted after 401. Every HTTP dispatch is separately metered. Token refreshes also use the one-unit profile reservation as conservative local accounting; this does not assert a Gmail quota cost for the OAuth endpoint. The durable account-source coordinator owns retry episodes, exponential backoff and exhaustion. The client persists provider waits through the quota service and never sleeps or buys capacity. A quota deferral, or a start that missed the quota's send window, sends nothing and throws `rate_limited` with the time to try again; only a reused attempt id is `invalid_response`. A retry time the client hands back is always after its own clock, even when the quota's database clock lags it; give the client the clock the host's sync store reads (`Date.now` for both unless given). Unknown errors become fixed failures without retaining their messages or causes.

Each operation refreshes the grant unless the client has a `tokenHolder`: a memory-only `{ current: null }` slot that the clients of one sync lease share. A held access token is reused only while `currentHandle` answers the lease it was obtained under (the same connection, generation and lease token) and that lease has not expired by the client's clock; a 401 drops it, and the repeat refreshes as before. A reused token skips the grant operation, so check the sync handle before and after each call, as the connector does. Give each lease a new holder and never persist or log it. `GmailSourceConnector` makes one for each connector, so a sync cycle refreshes the grant once.

A canonical thread 404 means gone. History 404 means the history anchor expired and bounded recovery is required. Domain policy is a fixed failure. Missing or explicitly invalid grants and insufficient scope are passed to the coordinator's fenced grant-loss lifecycle. Client configuration errors and transient network/provider failures are not reported as revoked mailboxes. Oversized successful thread responses are counted skips; oversized control pages fail without a cursor advance. Response streams are capped before decoding and are cancelled on size, deadline or caller cancellation.

The client performs no storage write, purge, logging, model request or attachment fetch. Its successful result is still untrusted source material and needs the host's fresh owner/generation/expiry checks before storage, preparation or delivery. Limits are defensive library policy, not provider maxima; hosts must record any live compatibility failure before changing them.

## Connector and durable synchronization

```ts
import { runGmailSourceSync, verifyGmailSource } from '@framers/agentos-ext-gmail-source';

const options = {
  scope, // the connection's tenant, owner and connection ids
  coordinator: { store, prepare, clock }, // the released AccountSourceSync options without provider and lifecycle
  revocations, // the host's SourceRevocations on the same tables
  connector: {
    api: { client, quota, projectKey: 'project-1', bounds, limits }, // as for GmailApi, without the handle and keys
    mailbox, // the host's private identity binding: key(handle) and accept(handle, address)
    bootstrapQuotaKey, // a stable keyed hash for the owner, never an address
    permission: async (request) => cachePermission, // the evidenced permission for a read, or null
    sourceDetailUrl: (scope, sourceId) => detailPath(sourceId), // an authenticated relative path, never a Gmail link
  },
};

// Once, after the host installed the grant and recorded its generation as grant-ready.
const verification = await verifyGmailSource(options, generation, signal); // { kind: 'verified' }, or why not
// Each scheduled or requested sync. The run's connector is disposed when the run ends.
const result = await runGmailSourceSync(options, 'scheduled', signal);
```

`GmailSourceConnector(options)` implements the original selected-id account-source interface and exposes the additive `sync` provider. It performs no document commit. Supply the released SQL sync store, revocation service, API configuration, dynamic current-handle getter, private mailbox binding, cache-permission callback, trusted relative detail-path builder and a stable opaque owner probe key. Every network operation uses the existing grant and quota services. The API clients it builds for one lease share one access token in memory, so a sync cycle refreshes the grant once; a 401 or a new lease refreshes it again, and disposal drops it. Never capture the first handle in a getter: source application can refresh the owner ticket.

The mailbox binding is server-only. Both callbacks run under the exact handle's transaction through the released store. `key(handle)` reads the existing stable mailbox key or returns null before initial acceptance. `accept(handle, address)` compares or atomically creates the host's private identity binding and returns its stable key; null refuses the identity. It cannot replace an existing identity on reconnect. Store any display address sealed, never in a source, telemetry field or URL. The initial profile is charged to a stable owner probe key; all content uses the accepted mailbox key. The shared project budget applies to both.

The connector verifies the mailbox before its first content operation even when a resumed coordinator skips `begin`. A fresh `begin` reads a new profile anchor before enumeration. Raw profile identity is passed only to the private binding. The connector retains no profile address. Each cycle can hold one sanitized label snapshot under its independent response expiry. Expired or refused names are omitted without repeated label requests. Cancellation, failure, cycle/generation changes and disposal clear the snapshot. Call `dispose()` in a finally block for direct use.

The original `list`, `read` and `changesSince` methods operate only on selected ids, bounded by the smaller retained and per-lease changed-item allowance and a hard ceiling of 100. Empty ids never enumerate a mailbox. Initial selected changes capture an anchor before reading the selection. Incremental selected changes drain bounded history and then reread only selected changed ids. A partial history, expired anchor, retry, skipped read or stale fence returns no successful cursor. Only a canonical missing thread is reported as removed. An empty selection with a null cursor returns an empty-string sentinel which must never be used with a nonempty selection or persisted as a provider history id.

Use `runGmailSourceSync(options, trigger, signal?)` for durable ingestion. Its options supply scope, coordinator configuration without a provider/lifecycle, the revocation service and connector configuration without a store/current-handle/clock/revocation service. The function constructs the released account-source coordinator, supplies this connector's sync provider and disposes the connector when the run ends. The coordinator alone owns candidate bounds, work persistence, retry episodes, history completion, reconciliation and generation-fenced application. A returned document is always passed through the released store's current policy and expiry checks. Do not persist a facade SourceRead directly and lose the full sync document's cache/provenance envelope.

After a host atomically installs a candidate sealed grant under an authenticated one-use start, transitions that same generation to grant-ready and records pending identity verification, it may call `verifyGmailSource(options, expectedGeneration, signal?)`. This claims a real lease, verifies the profile, binds identity and releases the lease without fetching content or advancing any cursor. Busy means another lease exists, not identity approval. A scheduled worker also verifies identity before content. Failed or cancelled authorization cannot install a grant after its generation was fenced. Hosts must clean up exchanged grants that could not be installed. Never create a synthetic handle to bypass the grant service.

`revoke()` invokes the released immediate fence/purge lifecycle and disposes the connector. Provider confirmation is a separate status from the revocation service; the account-independent queue worker performs that request. Run maintenance and expiry even while polling is paused. All source-derived results retain private ownership and deletion/expiry restrictions. This package exposes no send, reply, attachment download or general URL fetch.
