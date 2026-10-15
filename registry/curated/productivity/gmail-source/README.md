# Gmail source

This library provides read-only Gmail authorization on the AgentOS redirect grant and sealed-token contracts, and text helpers that sanitize and trim mail before it is stored (see Text ingestion below). It requests the sole Gmail read-only scope, offline access and incremental consent. It exports no send, reply, label-modification or attachment-download tool.

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

`policy` supplies `maxInputCharacters`, `maxLineCharacters` and `maxOutputCharacters` as positive UTF-16 code-unit counts. The input ceiling is 2,097,152 and the line ceiling is 65,536. The output cap cannot exceed the input cap. Oversized input throws `GmailTextFault` with a fixed reason; an overlong line is suppressed. Processing never scans only a truncated prefix for credentials. Repeated percent and common entity decoding is bounded, and unresolved encoded-byte lines are removed. Output truncation avoids splitting a surrogate pair and is marked in the result.

`messageText(input, policy)` sanitizes first, trims recognized reply history and short signatures, then applies the output cap. Explicit forwarded content and ambiguous prose are retained. Its `trimmedQuote`, `trimmedSignature` and `truncated` flags describe omissions. Quote spans must refer to its returned string, without inserted summaries or an ellipsis presented as source text. A host should disclose that attachments are listed and their contents are not read when its mapper implements that boundary.

The functions return text and counts only. They do not store raw values or a reverse-redaction map, log matches, fetch URLs, interpret mail as instructions or invoke a model. Sanitization can remove benign text and cannot identify every possible secret. It does not make personal mail anonymous or authorize model processing, sharing or retention. Hosts must preserve the source's privacy, expiry and deletion rules for both text and derived results.
