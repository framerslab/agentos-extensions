# @framers/agentos-ext-notion

Notion for a host that keeps its own grant: a public connection's OAuth on the AgentOS core's redirect flow, pages written as typed plain-text blocks inside Notion's request limits, and the pages a person shared with the connection read as an account source, as Markdown text inside the host's bounds.

```ts
import { NotionOAuthFlow, createNotionPage } from '@framers/agentos-ext-notion';

// The person's press of Connect: send them to the address, keep the state until they come back.
const flow = new NotionOAuthFlow({ clientId, clientSecret }, store);
const { url, state } = flow.beginNotion('https://example.com/api/notion/callback');

// Notion's return: check the state, exchange the code, keep the refresh token and the workspace.
const grant = await flow.complete({ code, state: returnedState, expectedState: state, codeVerifier: '', redirectUri });
await flow.keep(connectionId, grant);
grant.metadata; // { botId, workspaceId, workspaceName }

// A write: renew the grant (Notion rotates the refresh token, the store keeps the new one) and make the page.
const page = await createNotionPage({
  accessToken: await flow.accessToken(connectionId),
  title: 'Planning call, 27 October',
  blocks: [
    { kind: 'heading_2', text: 'Decisions' },
    { kind: 'bulleted_list_item', text: 'Ship on Friday', children: [{ kind: 'quote', text: 'Friday works for me.' }] },
    { kind: 'to_do', text: 'Book the room' },
  ],
});
page.url; // https://app.notion.com/p/<id>

// Disconnect: renew once, revoke the access token, clear the grant.
await flow.forget(connectionId); // { revoked: true }
```

## The connection

A public connection is made in Notion's developer portal with its installation scope, redirect URIs and capabilities, and its OAuth client id and secret are on its Configuration tab ([public connections](https://developers.notion.com/guides/get-started/public-connections.md)). The flow follows Notion's [authorization guide](https://developers.notion.com/guides/get-started/authorization.md):

- `beginNotion(redirectUri)` answers the authorization address with the client id, `response_type=code`, `owner=user`, the callback and a state of 32 random bytes, and nothing else. Notion's guide names no scope and no PKCE parameter, so the verifier answered is the empty word. The callback must be HTTPS (plain HTTP at a loopback host aside) with no query, fragment or userinfo.
- `complete` checks the state in constant time, then exchanges the code by a POST to `/v1/oauth/token` with HTTP Basic (`client_id:client_secret`) and the JSON body `{ grant_type, code, redirect_uri }` ([create a token](https://developers.notion.com/reference/create-a-token.md)). A grant is accepted only with a refresh token, a bot and a workspace; its `metadata` holds `botId`, `workspaceId` and `workspaceName` (the empty word when Notion gives none).
- `keep` hands the store the refresh token and the metadata alone, and refuses a grant without a refresh token, a bot or a workspace as `configuration`, keeping nothing. `accessToken` refreshes one at a time a key with the JSON body `{ grant_type: 'refresh_token', refresh_token }` ([refresh a token](https://developers.notion.com/reference/refresh-a-token.md)); Notion answers a new access token and a new refresh token, and the store keeps the new one; an answer whose `refresh_token` is null, which the reference's schema allows, keeps the one held. An access token is held in memory for the lifetime Notion names, or an hour when it names none.
- `revoke(token)` posts `{ token }` to `/v1/oauth/revoke` with HTTP Basic ([revoke a token](https://developers.notion.com/reference/revoke-token.md)); Notion's answer that the token is already invalid (400 with `invalid_grant`) counts as ended.
- `forget(key)` renews the kept grant once, revokes the access token the renewal gave, since Notion's revocation takes an access token, and clears the grant whatever Notion answers. It answers `revoked: true` when Notion ended the token or refused the renewal as `invalid_grant`.

A refused exchange, refresh or revocation throws the core's `OAuthGrantRefused` with the status and Notion's OAuth code (`invalid_grant`, `invalid_client` and the other RFC 6749 codes). Every call names `Notion-Version: 2026-03-11`, runs under a 15-second deadline and a 64 KiB answer cap, and stops on the caller's signal.

## Pages

`createNotionPage({ accessToken, title, blocks, parentPageId? })` writes a page and answers `{ id, url }`:

- With no `parentPageId` the page is a private page at the workspace level, which the [create page reference](https://developers.notion.com/reference/post-page.md) offers to public connections and personal access tokens. With one, the page goes under that page.
- Blocks are `heading_1`, `heading_2`, `heading_3`, `paragraph`, `bulleted_list_item`, `numbered_list_item`, `quote` and `to_do` (with `checked`), each holding plain text alone, and a paragraph, list item, quote or to-do may hold one level of children. Text becomes rich text items of at most 2,000 characters, never cut inside a surrogate pair; control characters are dropped and a lone surrogate becomes U+FFFD. No link, mention or annotation is ever made from the text.
- `planNotionPage` plans every request before any call inside Notion's [request limits](https://developers.notion.com/reference/request-limits.md): 100 rich text items a block, 100 blocks an array, 1,000 blocks and 450,000 bytes a request. The page is created with as many blocks as fit and the rest are appended to its end in order through [append block children](https://developers.notion.com/reference/patch-block-children.md). A block no request can hold is refused as `too_large`, with nothing written.
- The link is the one Notion answered when it is an HTTPS link on Notion's hosts, else `https://app.notion.com/p/<id>`, the form Notion's [versioning reference](https://developers.notion.com/reference/versioning.md) gives for its page links. A connection with Insert content alone may be answered a partial page without its link.

Every call is made once. A failure is a `NotionFault` whose `reason` is fixed: `unauthorized` (401: the grant no longer works), `restricted` (403, 404, or a connection Notion blocked), `refused` (400), `rate_limited` (429 or 529, with `retryAfterMs` from `Retry-After`), `unavailable` (409), and `unknown_outcome` for a write whose answer was lost, ran past the 65-second deadline or was a 5xx, or a success that names no page, since Notion's [status codes](https://developers.notion.com/reference/status-codes.md) say a write can be saved and still answer 503. A 503 that names the page it committed (`additional_data.committed_resource_id`) is taken as the page made. When an append fails, the fault's `pageId` names the page made without the rest of its blocks.

## Read the pages a connection is shared

`NotionReadConnector` reads the pages a person shared with a public connection as an account source, the `AccountSourceConnector` contract of [`@framers/agentos-ext-account-sources`](https://www.npmjs.com/package/@framers/agentos-ext-account-sources): a listing of the pages, the changes since a cursor, and each page as Markdown text with its attribution. It reads with the access token of the connection's OAuth grant, which `NotionOAuthFlow.accessToken` renews. The person chooses the pages in Notion's page picker when they authorize, and sharing a parent page shares the pages under it ([authorization](https://developers.notion.com/guides/get-started/authorization.md)).

```ts
import { NotionReadConnector } from '@framers/agentos-ext-notion';

const pages = new NotionReadConnector({
  accessToken: await flow.accessToken(connectionId),
  maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000,
  concurrency: 3,
});

const { items, gone } = await pages.list({ ids: [] });         // newest edited first, up to maxPages
const read = await pages.read(items[0]);                       // { item, content: { text }, ref }, or { id, reason }
const changes = await pages.changesSince(cursor, { ids: [] }); // { changed, gone, cursor }
```

- **`list(selection)`** with no ids searches pages (`POST /v1/search`, filtered to pages, newest edited first) page after page up to `maxPages` ([search](https://developers.notion.com/reference/post-search.md)), leaving out pages in the trash. With ids it retrieves each page: a 404 or a page in the trash answers `{ id, reason: 'removed' }`, a 403 `{ id, reason: 'no_access' }`. An item is `{ id, title, size: null, version, parent }`: the title property as plain text, the page's `last_edited_time` as its version, and its parent's `type` (`workspace`, `page`, `database` or `block`) and `id`.
- **`changesSince(cursor, selection)`** takes a cursor that is a JSON object of the page ids a host holds and their versions (`null` for none). Notion's search index takes time to show a page shared, unshared or moved to the trash ([search limitations](https://developers.notion.com/reference/search-optimizations-and-limitations.md)), so with no ids every page the cursor holds is retrieved on every call whatever search says, and one relist adds the pages the cursor does not hold, up to `maxPages`; with ids, those pages alone are retrieved and no relist runs. A retrieved version unlike the cursor's is `changed`, a page gone is in `gone` with its reason, `changed` is newest edited first, and the cursor answered holds every page that answered at the version it answered. A page the relist adds is search's word alone, which can lag an unshare; `read` retrieves it first and answers `removed` or `no_access` when it is gone.
- **`read(item)`** retrieves the page, then reads its blocks one level a call, 100 a call (`GET /v1/blocks/{id}/children`, [block children](https://developers.notion.com/reference/get-block-children.md)), and writes them as Markdown: headings with `#` marks, list items with `-` or their numbers, their later lines and their children indented to where their text starts (two spaces under `-` and a check box, the number's width and a space under a number; a code block's text too), to-dos with a check box, quotes with `>` (their children quoted with them, and a blank line after), code fenced with its language (the fence longer than any run of backticks in the code), and a table's rows as their cells separated by ` | `. Rich text is read as its plain text, so a mention or a link is its words. An image, a file, a video, an audio clip, a PDF, an embed and a bookmark are written as their captions alone: no address is written and nothing at an address is fetched. A child page and a child database are written as their titles, and nothing inside them is read. A synced block, a column list, a column and a tab add their children's lines; any other block type is left out ([block](https://developers.notion.com/reference/block.md)). The read answers `{ item, content: { text }, ref }`, `ref` being `{ kind: 'notion', title, url, version, readAt }`.
- **Bounds.** `maxBlocks` counts a page's blocks at every level, `maxDepth` its levels (the page's own blocks are level 1) and `maxChars` the characters of its Markdown text. A page past any of them answers `{ id, reason: 'too_large' }` and is never cut. Blocks and characters are counted as the blocks arrive (each block by the fewest characters it writes), so once a bound is passed no further call starts. A fault a call in flight answers after that, such as a 429, is still what the read throws. A listing of children that answers a cursor it answered before throws `invalid_response`.
- **Access lost during a read.** A 404 or 403 on the page's first children call answers `removed` or `no_access`. On any later children call the page is retrieved again: the read answers why it is gone, or throws `unavailable` when it is still there, so a host keeps its earlier copy and reads again later.
- **The capability check.** A connection without the Read content capability cannot read pages ([capabilities](https://developers.notion.com/reference/capabilities.md)): search's 403 throws `NotionFault` with `reason` `restricted` and `status` 403, and nothing is read.
- **Pacing.** Notion allows a connection 180 requests a minute, 600 on Business and Enterprise plans, and answers 429 with `Retry-After` past it ([request limits](https://developers.notion.com/reference/request-limits.md)). Without `send`, the connector keeps a sliding one-minute window of `requestsPerMinute` calls (180 when absent) that counts every call in flight; while a call waits for a place, the window's timers hold a Node process open, and once none waits they let it end. With `send`, every call goes through the host's shared budget with its method word (`search`, `retrieve` or `children`), and the connector paces nothing itself. A 429 throws `rate_limited` with `retryAfterMs` from `Retry-After`; nothing is retried, and no call follows it.
- **`concurrency`** is how many calls a `list`, `read` or `changesSince` keeps in flight, 1 when absent and at most 64. Answers are put back in their order, so a listing, a read or a set of changes that ends with no fault and no bound passed answers what one call at a time answers, with the same calls. When one stops early (a fault, a bound, a page gone), the calls already sent settle first, so the calls made, and which fault is thrown, can differ from one call at a time; a fault outranks a stop that is no fault. A fault starts no further call: a call still waiting for its place in the window, or for the host's `send`, is never sent, and the fault is thrown once the calls already sent have settled.

Every call names `Notion-Version: 2026-03-11`, runs under `timeoutMs` (30 seconds when absent) with a 2,000,000-byte answer cap, and stops on the connector's `signal` or the operation's; a call the host's `send` holds stops being waited on once either aborts. `revoke()` ends the grant through the `revoke` the host gives, and does nothing without one. Every failure the connector raises is a `NotionFault`: `configuration` for an option or an input refused before any call, `cancelled` once a signal has aborted, `unauthorized` (401), `restricted` (search's 403, or a connection Notion blocked), `refused` (400), `rate_limited` (429 or 529, with `retryAfterMs`), `unavailable` (409 or a 5xx), `invalid_response` for an answer that is not the shape Notion documents, and the transport's `timeout`, `network` and `response_too_large`. A host's `send` that rejects with an error of its own passes that error through unchanged.

## Stand-ins

On CI alone (`CI=true`), `NotionOAuthFlow` takes stand-in `endpoints`, and `createNotionPage` and `NotionReadConnector` a stand-in `apiBase`, each at a loopback or `.invalid` host. Never take them from a request.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
