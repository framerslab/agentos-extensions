# Gmail source

This library provides read-only Gmail authorization on the AgentOS redirect grant and sealed-token contracts. It requests the sole Gmail read-only scope, offline access and incremental consent. It exports no send, reply, label-modification or attachment-download tool.

Install it next to `@framers/agentos` 0.13.134 or later and `@framers/agentos-ext-account-sources` 0.4.0 or later. Both are peer dependencies with a floor and no upper bound. Node.js 20.19 or later is required.

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

Construct a flow for each scheduled token operation, with that operation's sealed store and abort signal, call `accessToken`, and discard the flow at the end of the operation. A store scoped to one operation must never be retained for another worker. The host's durable lifecycle owns disconnect, purge, refresh exclusion across workers and revocation. `forget` on an independently held flow is not a cross-worker lifecycle operation.

OAuth responses are capped at 65,536 bytes and must finish within 15 seconds. Parent cancellation stops dispatch and body consumption. Fixed `GmailOAuthFault` reasons contain no provider message or credential. When an exchange succeeds and `complete` does not return the grant, because the grant fails the checks or because the parent cancelled before `complete` returned, the flow asks Google to revoke the grant before it throws. That revocation has the same byte cap and a 15-second deadline of its own, and the parent's cancellation does not stop it. The fault's `cleanup` field then reads `confirmed` or `unconfirmed`. An unconfirmed outcome needs a provider-permission removal instruction. It does not authorize retaining the grant.

The host supplies informed consent, cache permission, retention policy, account isolation and a truthful availability state. Authorization alone does not establish permission to store or send mailbox content to a model. Do not infer those permissions from this package's successful tests.

Protocol references: https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/workspace/gmail/api/auth/scopes.
