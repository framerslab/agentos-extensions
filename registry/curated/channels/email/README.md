# @framers/agentos-ext-channel-email

Email for AgentOS. `EmailService` sends mail through SMTP or Resend's HTTPS API, and reads, searches, extracts codes from and replies to mail through IMAP. The pack's factory wraps the service in a messaging-channel adapter and five tools for an agent. Two stores on a host's SQL database keep what a sender reads before a send: a suppression record and the tokens of unsubscribe links.

## Installation

```bash
npm install @framers/agentos-ext-channel-email
```

It needs Node.js 20 or later, the floor of nodemailer 10. Its runtime dependencies are [nodemailer](https://github.com/nodemailer/nodemailer) for SMTP and [imapflow](https://github.com/postalsys/imapflow) for IMAP. `@framers/agentos` is an optional peer, needed only when an agent loads the pack: nothing in the pack imports it, so `EmailService` works without it.

## Sending through SMTP

```ts
import { EmailService } from '@framers/agentos-ext-channel-email';

const email = new EmailService({
  smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: process.env.SMTP_PASSWORD ?? '' },
  from: 'Example <hello@example.com>',
});
await email.initialize();
await email.sendEmail({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', html: '<p>Plain words.</p>' });
```

`smtp` takes `host`, `user` and `password`, with `port` and `secure`: by default the connection uses TLS on port 465, and `secure: false` moves the default port to 587. `initialize()` checks the connection, and a failed check is not an error. The pack's factory reads the account from the secrets `email.smtpHost`, `email.smtpUser` and `email.smtpPassword`, or from `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD`.

## Sending through Resend

```ts
import { EmailService } from '@framers/agentos-ext-channel-email';

const email = new EmailService({
  resend: { apiKey: process.env.RESEND_API_KEY ?? '' },
  from: 'Example <hello@example.com>',
});
await email.initialize();
const { messageId } = await email.sendEmail({
  to: 'reader@example.com',
  subject: 'Hello',
  body: 'Plain words.',
  html: '<p>Plain words.</p>',
  replyTo: 'team@example.com',
  idempotencyKey: 'welcome-reader-1',
});
```

Each message goes out as `POST /emails` with the key as the bearer and the text and HTML parts in the same call, and `messageId` is the id Resend gives the email, or the empty string when an accepted answer names none or its body cannot be read: a 2xx means the email was sent, so the send never fails after one. A refusal that is tried again repeats the same request, with the same key and any `Idempotency-Key`, so one send makes at most `maxRetries + 1` requests. `idempotencyKey` is sent as Resend's `Idempotency-Key` header: another request under the same key within 24 hours delivers nothing more ([idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)). Keep it to 256 characters at most and free of personal data. SMTP ignores it.

Attachments take a `filename` with `content` (a string or a Buffer, sent as Base64) or a `path`. Through Resend, an `http` or `https` path is the address Resend fetches the file from, and a `data:` address or a file on this host is read by the transport and sent as content, as nodemailer reads both over SMTP; when `content` is given too, such a path is left out. A file that cannot be read throws its own error before any request. Through either transport `sendEmail` reads a file on this host, and through SMTP it fetches an `http` or `https` address, from this process: such a path must come from the developer's code and never from a model's output. The `emailSend` tool and the channel adapter take only `content`, a `data:` address and, through Resend, an `http` or `https` address.

| `resend` option | Default | What it sets |
|---|---|---|
| `apiKey` | required | The API key, or a function that returns it at each send, so a rotated key applies without a restart |
| `baseUrl` | `https://api.resend.com` | The API's origin, such as a proxy's or a test server's |
| `userAgent` | `agentos-ext-channel-email` | The `User-Agent` of every request; Resend refuses a request without one |
| `timeoutMs` | 15,000 | The longest one send may take, its retries and their waits included |
| `maxRetries` | 2 | The most retries one send makes |

The pack's factory sends through Resend when it has a Resend key and no SMTP host: the option `resendApiKey`, the secret `email.resendApiKey` or `RESEND_API_KEY`, with `resendBaseUrl` for the origin. Given an SMTP host, it keeps SMTP.

## The From

`from` sets the From header of both transports, and a display name is allowed (`Example <hello@example.com>`). With SMTP it falls back to the SMTP user; with Resend it is required, and `initialize()` throws without it. Replies are sent from it too. The pack's factory reads it from the option `from`, then from `EMAIL_FROM`.

## Header fields

`sendEmail` adds the fields in `headers` to the message, by name. A one-click unsubscribe ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)) is a pair of them:

```ts
await email.sendEmail({
  to: 'reader@example.com',
  subject: 'Your weekly summary',
  body: 'Plain words.',
  headers: {
    'List-Unsubscribe': '<https://example.com/unsubscribe?t=opaque-token>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
});
```

Through Resend the fields go in the request's `headers` ([custom headers](https://resend.com/docs/dashboard/emails/custom-headers)); through SMTP nodemailer writes each into the message. `headers` is a plain object of names and values. A name is printable US-ASCII with no space or colon, the field name of RFC 5322, and a value is a string with no line break or other control character than the tab, so no field can end and start another. Each value is read once, and the fields are sent as read.

`headers` adds fields and never replaces the service's own: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and every `Content-` field are refused, in any case. The recipients, the reply-to and the subject have their own options, and the From comes from the configuration's `from`. A name given twice in different cases is refused too. A refusal throws an `Error` before either transport is used, naming the field, or its place in the object when its name is at fault, and none of its value. The `emailSend` tool and the channel adapter add no header fields.

## Suppressions and unsubscribe tokens

Two stores a sender reads, each on the host's SQL database: `SqlSuppressionStore` keeps the addresses not to mail, each named by its SHA-256, and `SqlRecipientCapability` keeps opaque tokens, such as an unsubscribe link's, each naming a recipient and a scope. Both take [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter)'s adapter on SQLite or PostgreSQL, or any handle with its `run` and `get` (`?` placeholders, positional parameters), so the pack gains no dependency.

```ts
import { createHash } from 'node:crypto';
import { createDatabase } from '@framers/sql-storage-adapter';
import {
  DEFAULT_SUPPRESSION_SCOPE,
  SqlRecipientCapability,
  SqlSuppressionStore,
  emailPreferencesDdl,
} from '@framers/agentos-ext-channel-email';

// strict: with DATABASE_URL unset, throw rather than open a local database in its place
const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true });
await db.exec(emailPreferencesDdl('mail')); // mail_suppressions and mail_capabilities

// A bounce reported by the provider: the store gets the address's hash, never the address.
const suppressions = new SqlSuppressionStore(db, 'mail');
const addressHash = createHash('sha256').update('reader@example.com'.toLowerCase()).digest('hex');
await suppressions.suppress(DEFAULT_SUPPRESSION_SCOPE, addressHash, 'bounce', '2026-10-15');
const skip = await suppressions.isSuppressed(DEFAULT_SUPPRESSION_SCOPE, addressHash); // true: send nothing

// An unsubscribe link: the message's id is the nonce, so a retried message carries the same token.
const tokens = new SqlRecipientCapability(db, 'mail');
const key = Buffer.from(process.env.UNSUBSCRIBE_KEY ?? '', 'hex'); // 32 bytes or more, kept secret
const token = await tokens.issue('account-1', 'weekly-summary', 'message-42', key);
const link = `https://example.com/unsubscribe?t=${token}`;
const grant = await tokens.find(token); // { recipient: 'account-1', scope: 'weekly-summary' }, or null
```

`suppress(scope, addressHash, reason, day)` records an address in a scope with its reason and its day (`YYYY-MM-DD`), and no end: the store has no call that lifts an address, so an operator lifts one by deleting its row (`DELETE FROM <prefix>_suppressions WHERE scope = ? AND address_hash = ?`). The reason is `bounce`, `complaint`, `suppressed` (the provider refused a message because its own list held the address) or `manual`. A second record of the address in the scope writes nothing and keeps the first, so a provider's repeated event is harmless; `suppress` answers `true` only for the call that recorded it, and two hosts recording one address at once leave one row. `isSuppressed(scope, addressHash)` answers for one scope. A scope is one list, and a host that keeps one passes `DEFAULT_SUPPRESSION_SCOPE` (`mail`) everywhere. `addressHash` is the SHA-256 of the address as 64 lower-case hexadecimal characters, which the host computes the same way wherever it reads or writes the record. Any other value, an address among them, throws a `TypeError` that holds none of it, so a mistake stores nothing and is never answered as not suppressed.

`issue(recipient, scope, nonce, key)` answers base64url of HMAC-SHA256 over the nonce under the key, 43 characters, and stores the token's SHA-256 beside the recipient and the scope: the token carries neither, and the table holds nothing it can be recovered from. The same nonce under the same key gives the same token, so each message takes a nonce of its own, such as its id. Issuing it again for the same recipient, scope and expiry writes nothing; for another recipient, scope or expiry it throws, and the first token keeps all three. The key is 32 bytes or more, given as bytes; a different key gives different tokens for the same nonces. `find(token)` answers the recipient and the scope, or `null` for a token that is malformed, unknown, revoked or past its expiry: it looks the token up by its SHA-256 and compares in constant time. `revoke(recipient)` ends every token of the recipient, in every scope, and answers how many it ended. Each revoked row stays, marked with the time of the revoke, so `issue` refuses a revoked token's nonce for every recipient, scope and expiry: a revoked link never works again and never comes to name someone else. A message that needs a working token after a revoke takes a new nonce, and the token it gets works. A token has no expiry unless `issue`'s options set `expiresAt`, in epoch milliseconds.

`suppressionStoreDdl(prefix)` makes the table `<prefix>_suppressions` (`scope`, `address_hash`, `reason`, `suppressed_on`), `recipientCapabilityDdl(prefix)` makes `<prefix>_capabilities` (`token_hash`, `recipient`, `scope`, `expires_at`, `revoked_at`) with its index on the recipient, and `emailPreferencesDdl(prefix)` makes both. The prefix is a lower-case letter and at most 39 lower-case letters, digits or underscores, and it keeps two hosts on one database apart. The statements are `CREATE ... IF NOT EXISTS` and run on SQLite and PostgreSQL. A token's row refuses its nonce for as long as it stays, revoked or not. A host that deletes a recipient's rows, by its own foreign key with `ON DELETE CASCADE` or by hand, never issues their nonces again: each message's nonce is one no other message ever had, such as a random id or a row id that is never reused. A host that cannot promise that calls `revoke` with each deletion and keeps the rows. Each store checks every argument before its first statement. A scope, a recipient and a nonce are strings of 1 to 512 characters with no U+0000, which PostgreSQL's text refuses, and no lone surrogate, which UTF-8 cannot encode, so a driver would store something else in its place: any other value throws a `TypeError` that holds none of it, and a name is stored as given on every backend. A database error passes through as it was thrown. A store made on the handle that the adapter's `transaction` gives its callback writes inside that transaction. On a server, open the database as the example does, with the adapter's `strict` option (0.6.15 or later): without it, a `url` that is unset opens a local SQLite database in its place, and the record a sender reads before each send would live there.

## Errors and retries

A refusal from Resend throws `EmailApiError`, with `status` (the HTTP status), `type` (Resend's error name, such as `validation_error`, or `unknown` when the answer's body is not JSON, names no error, or names one that is not 1 to 64 letters, digits, `_`, `.`, `:` or `-`) and `retryAfterSeconds` (the answer's `retry-after`, or `null`). Its message names the status and the type and never carries Resend's message, which can quote an address.

`fetch`'s own errors pass through as it throws them: a `TypeError` when the connection fails, and a `TimeoutError` when `timeoutMs` passes before an answer comes. A deadline that passes while an answer's body is being read throws no `TimeoutError`: a refusal then throws `EmailApiError` with `type` `unknown`, and an accepted send resolves with an empty `messageId`. The key is trimmed at each send. A key, an `idempotencyKey` or a `userAgent` that holds a character an HTTP header cannot carry (a line break or another control character other than a tab, or a character above U+00FF) throws an `Error` before any request, and its message names which one and none of its value. `ResendTransport.send` checks a message's `headers` by the rules for names and values in [header fields](#header-fields), though not against the fields the service writes, and throws the same way: a reply through Resend whose message id holds a line break is refused rather than sent in `In-Reply-To` and `References`.

A send is tried again only on the terms of Resend's [errors](https://resend.com/docs/api-reference/errors) and [rate limit](https://resend.com/docs/api-reference/rate-limit) pages, as `retryWaitSeconds` decides:

- `rate_limit_exceeded` (429): always, since nothing was sent;
- `concurrent_idempotent_requests` (409) and any 5xx, such as `application_error` (500) and `service_unavailable` (503): only when the send has an `idempotencyKey`, so a retry cannot deliver twice;
- never `daily_quota_exceeded` or `monthly_quota_exceeded` (both 429), `validation_error`, `invalid_idempotent_request` or any other 4xx.

The wait is the answer's `retry-after` when it has one, else as many seconds as the retry's number: one, then two. A send makes at most `maxRetries` retries, and a wait that would pass the deadline is not taken: the refusal is thrown instead.

## Reading mail

`readInbox`, `searchEmails`, `extractCodes` and `replyToEmail` read through IMAP: the `imap` account (`host`, `user` and `password`, with `port` and `secure`, by default TLS on port 993), or the SMTP account when `imap` is not given. With Resend, reading needs `imap`. A reply goes out through the transport that sends, threaded with `In-Reply-To` and `References`. The pack's factory reads the account from the secrets `email.imap.host`, `email.imap.user` and `email.imap.password`, or from `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD`.

## In an agent

`createExtensionPack(context)` returns five tools, `emailSend`, `emailRead`, `emailSearch`, `emailExtractCodes` and `emailReply`, and the messaging channel `emailChannel`. Its options (`smtpHost`, `smtpUser`, `smtpPassword`, `smtpPort`, `smtpSecure`, `imapHost`, `imapUser`, `imapPassword`, `imapPort`, `imapSecure`, `resendApiKey`, `resendBaseUrl`, `from`) take precedence over the secrets and the environment variables named above. `manifest.json` lists the SMTP secrets as required, and the IMAP secrets and `email.resendApiKey` as optional.

A model names the tools' arguments and the channel's blocks, so `emailSend` and `emailChannel` pass on an attachment only as `content`, a `data:` address or, through Resend, an `http` or `https` address. They refuse any other before anything is sent, reading no file and fetching no address: the tool answers `{ success: false, error }`, the adapter throws an `Error`, and the message names the attachment's filename, never its path.

They send each attachment as they checked it: a copy of its own `filename`, `content`, `path` and `contentType`, each read once, with a Buffer's bytes copied. They refuse the same way an attachment that is not an object, one that gives any of those four through a getter or a setter, and one whose `filename` or `contentType` is not a string. Any other property of an attachment is left out.

The subject, the bodies and the message id a reply names must be text. Through SMTP, nodemailer reads the file or fetches the address an object body names into the message, and writes an object subject or message id marked `prepared` into the headers as it is. So `sendEmail` and `replyToEmail`, whoever calls them, throw a `TypeError` that names the field, never its value, before anything is sent on either transport: `subject`, `body` and the reply's `messageId` must be strings, and `html` a string when given (`null` leaves the HTML part out). `emailSend` and `emailReply` answer it as `{ success: false, error }`, and the adapter throws it.

## API

| Export | What it is |
|---|---|
| `createExtensionPack(context)` | The pack's factory: the five tools and the channel adapter |
| `EmailService` | Sends through SMTP or Resend's HTTPS API; reads, searches, extracts codes and replies through IMAP |
| `ResendTransport` | Resend's send call, which `EmailService` uses when its configuration names `resend` |
| `EmailApiError`, `retryWaitSeconds` | A refusal from Resend, and the wait before its retry (`null` for none) |
| `EmailChannelAdapter` | The messaging-channel adapter |
| `EmailSendTool`, `EmailReadTool`, `EmailSearchTool`, `EmailExtractCodesTool`, `EmailReplyTool` | The five tools |
| `SqlSuppressionStore`, `suppressionStoreDdl(prefix)` | The suppression record on a SQL database, and its table's DDL |
| `SqlRecipientCapability`, `recipientCapabilityDdl(prefix)` | Recipient capabilities on a SQL database, and their table's DDL |
| `emailPreferencesDdl(prefix)` | Both tables' DDL |
| `DEFAULT_SUPPRESSION_SCOPE`, `SUPPRESSION_REASONS` | The scope of a host that keeps one list (`mail`), and the reasons an address is suppressed |
| `EmailConfig`, `SendEmailOptions`, `EmailMessage`, `SearchEmailOptions`, `ResendOptions`, `OutgoingEmail`, `OutgoingAttachment`, `EmailChannelOptions`, `ExtensionContext`, `ExtensionPack` | The types of the configuration, the messages, the options and the pack |
| `SuppressionStore`, `SuppressionReason`, `RecipientCapability`, `RecipientGrant`, `RecipientCapabilityIssueOptions`, `SqlRecipientCapabilityOptions`, `EmailPreferencesDb` | The stores' interfaces, their answers and options, and what they need of a database |

## License

Apache-2.0
