# @framers/agentos-ext-notion

Notion for a host that keeps its own grant: a public connection's OAuth on the AgentOS core's redirect flow, and pages written as typed plain-text blocks inside Notion's request limits.

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
- `keep` hands the store the refresh token and the metadata alone. `accessToken` refreshes one at a time a key with the JSON body `{ grant_type: 'refresh_token', refresh_token }` ([refresh a token](https://developers.notion.com/reference/refresh-a-token.md)); Notion answers a new access token and a new refresh token, and the store keeps the new one. An access token is held in memory for the lifetime Notion names, or an hour when it names none.
- `revoke(token)` posts `{ token }` to `/v1/oauth/revoke` with HTTP Basic ([revoke a token](https://developers.notion.com/reference/revoke-token.md)); Notion's answer that the token is already invalid (400 with `invalid_grant`) counts as ended.
- `forget(key)` renews the kept grant once, revokes the access token the renewal gave, since Notion's revocation takes an access token, and clears the grant whatever Notion answers. It answers `revoked: true` when Notion ended the token or refused the renewal as `invalid_grant`.

A refused exchange, refresh or revocation throws the core's `OAuthGrantRefused` with the status and Notion's OAuth code (`invalid_grant`, `invalid_client` and the other RFC 6749 codes). Every call names `Notion-Version: 2026-03-11`, runs under a 15-second deadline and a 64 KiB answer cap, and stops on the caller's signal.

## Pages

`createNotionPage({ accessToken, title, blocks, parentPageId? })` writes a page and answers `{ id, url }`:

- With no `parentPageId` the page is a private page at the workspace level, which the [create page reference](https://developers.notion.com/reference/post-page.md) offers to public connections and personal access tokens. With one, the page goes under that page.
- Blocks are `heading_1`, `heading_2`, `heading_3`, `paragraph`, `bulleted_list_item`, `numbered_list_item`, `quote` and `to_do` (with `checked`), each holding plain text alone, and a paragraph, list item, quote or to-do may hold one level of children. Text becomes rich text items of at most 2,000 characters, never cut inside a surrogate pair; control characters are dropped and a lone surrogate becomes U+FFFD. No link, mention or annotation is ever made from the text.
- `planNotionPage` plans every request before any call inside Notion's [request limits](https://developers.notion.com/reference/request-limits.md): 100 rich text items a block, 100 blocks an array, 1,000 blocks and 450,000 bytes a request. The page is created with as many blocks as fit and the rest are appended to its end in order through [append block children](https://developers.notion.com/reference/patch-block-children.md). A block no request can hold is refused as `too_large`, with nothing written.
- The link is the one Notion answered when it is an HTTPS link on Notion's hosts, else `https://app.notion.com/p/<id>`, the form Notion's [versioning reference](https://developers.notion.com/reference/versioning.md) gives for its page links. A connection with Insert content alone may be answered a partial page without its link.

Every call is made once. A failure is a `NotionFault` whose `reason` is fixed: `unauthorized` (401: the grant no longer works), `restricted` (403, 404, or a connection Notion blocked), `refused` (400), `rate_limited` (429 or 529, with `retryAfterMs` from `Retry-After`), `unavailable` (409), and `unknown_outcome` for a write whose answer was lost, ran past the 65-second deadline or was a 5xx, since Notion's [status codes](https://developers.notion.com/reference/status-codes.md) say a write can be saved and still answer 503. A 503 that names the page it committed (`additional_data.committed_resource_id`) is taken as the page made. When an append fails, the fault's `pageId` names the page made without the rest of its blocks.

## Stand-ins

On CI alone (`CI=true`), `NotionOAuthFlow` takes stand-in `endpoints` and `createNotionPage` a stand-in `apiBase`, each at a loopback or `.invalid` host. Never take them from a request.

## License

Apache-2.0
