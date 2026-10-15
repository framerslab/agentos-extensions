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

Through Resend the fields go in the request's `headers` ([custom headers](https://resend.com/docs/dashboard/emails/custom-headers)); through SMTP nodemailer writes each into the message as given, folded at its white space. Both transports get the same text, so `headers` takes only what both carry alike:

- `headers` is a plain object of names and values, made in this realm or in another, such as a `vm` context. A list, a `Map` or text is refused.
- A name is printable US-ASCII with no space or colon, the field name of RFC 5322, given once in any case.
- A value is a string of printable US-ASCII words, with one space or tab between each two and none at either end. An empty or blank value is refused: nodemailer would leave the field out, and Resend would send it empty. So is a character outside US-ASCII, which nodemailer would write as an RFC 2047 encoded word that a structured field such as `List-Unsubscribe` cannot hold; percent-encode a link instead. A line break or any other control character is refused, so no field can end and start another, and so is white space at either end or two white-space characters in a row, which nodemailer can fold into a line of white space alone: obsolete syntax ([RFC 5322 section 4.2](https://www.rfc-editor.org/rfc/rfc5322#section-4.2)) that a message must not be written with.
- No word may be so long that the name, a colon, a space and the word pass 998 characters, the longest line [RFC 5322 section 2.1.1](https://www.rfc-editor.org/rfc/rfc5322#section-2.1.1) allows: a field folds only at its white space, so a word stays on one line. A `List-Unsubscribe` link holds at most 980 characters.
- `In-Reply-To` and `References` list message ids, each in angle brackets, such as `<id@example.com>`.

Each value is read once, and the fields are sent as read. A value with a double quote, such as a `List-Id` of `"Weekly summary" <weekly.example.com>`, arrives as written through both transports. Two differences stay, and neither changes what a field means: nodemailer writes a name in its own case, such as `List-ID` for `List-Id`, and RFC 5322 makes field names case-insensitive; and it writes `Sender` as the address it parses from the value, the same mailbox. Resend's [custom headers](https://resend.com/docs/dashboard/emails/custom-headers) page and its [send call](https://resend.com/docs/api-reference/emails/send-email) do not say how Resend writes a long field into the message.

`headers` adds fields and never replaces the service's own: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and every `Content-` field are refused, in any case. The recipients, the reply-to and the subject have their own options, and the From comes from the configuration's `from`. A name given twice in different cases is refused too. A refusal throws an `Error` before either transport is used, naming the field, or its place in the object when its name is at fault, and none of its value. The `emailSend` tool and the channel adapter add no header fields.

The subject goes out on one line through both transports: each line break in it, and each other control character but the tab, is sent as a space, as nodemailer writes a line break in a subject.

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

const db = await createDatabase({ url: process.env.DATABASE_URL });
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

`suppress(scope, addressHash, reason, day)` records an address in a scope with its reason and its day (`YYYY-MM-DD`), and no end. The reason is `bounce`, `complaint`, `suppressed` (the provider refused a message because its own list held the address) or `manual`. A second record of the address in the scope writes nothing and keeps the first, so a provider's repeated event is harmless; `suppress` answers `true` only for the call that recorded it, and two hosts recording one address at once leave one row. `isSuppressed(scope, addressHash)` answers for one scope. A scope is one list, and a host that keeps one passes `DEFAULT_SUPPRESSION_SCOPE` (`mail`) everywhere. `addressHash` is the SHA-256 of the address as 64 lower-case hexadecimal characters, which the host computes the same way wherever it reads or writes the record. Any other value, an address among them, throws a `TypeError` that holds none of it, so a mistake stores nothing and is never answered as not suppressed.

`issue(recipient, scope, nonce, key)` answers base64url of HMAC-SHA256 over the nonce under the key, 43 characters, and stores the token's SHA-256 beside the recipient and the scope: the token carries neither, and the table holds nothing it can be recovered from. The same nonce under the same key gives the same token, so each message takes a nonce of its own, such as its id. Issuing it again for the same recipient and scope writes nothing; for another recipient or scope it throws, and the first token keeps its recipient and scope. The key is 32 bytes or more, given as bytes; a different key gives different tokens for the same nonces. `find(token)` answers the recipient and the scope, or `null` for a token that is malformed, unknown, revoked or past its expiry: it looks the token up by its SHA-256 and compares in constant time. `revoke(recipient)` ends every token of the recipient, in every scope, and answers how many it ended. Each revoked row stays, marked with the time of the revoke, so `issue` refuses a revoked token's nonce for every recipient, scope and expiry: a revoked link never works again and never comes to name someone else. A message that needs a working token after a revoke takes a new nonce, and the token it gets works. A token has no expiry unless `issue`'s options set `expiresAt`, in epoch milliseconds.

`suppressionStoreDdl(prefix)` makes the table `<prefix>_suppressions`, `recipientCapabilityDdl(prefix)` makes `<prefix>_capabilities` (`token_hash`, `recipient`, `scope`, `expires_at`, `revoked_at`) with its index on the recipient, and `emailPreferencesDdl(prefix)` makes both. The prefix is a lower-case letter and at most 39 lower-case letters, digits or underscores, and it keeps two hosts on one database apart. The statements are `CREATE ... IF NOT EXISTS` and run on SQLite and PostgreSQL. A token's row refuses its nonce for as long as it stays, revoked or not. A host that deletes a recipient's rows, by its own foreign key with `ON DELETE CASCADE` or by hand, never issues their nonces again: each message's nonce is one no other message ever had, such as a random id or a row id that is never reused. A host that cannot promise that calls `revoke` with each deletion and keeps the rows. Each store checks every argument before its first statement and lets a database error through as it was thrown. A store made on the handle that the adapter's `transaction` gives its callback writes inside that transaction.

## Errors and retries

A refusal from Resend throws `EmailApiError`, with `status` (the HTTP status), `type` (Resend's error name, such as `validation_error`, or `unknown` when the answer's body is not JSON, names no error, or names one that is not 1 to 64 letters, digits, `_`, `.`, `:` or `-`) and `retryAfterSeconds` (the answer's `retry-after`, or `null`). Its message names the status and the type and never carries Resend's message, which can quote an address.

`fetch`'s own errors pass through as it throws them: a `TypeError` when the connection fails, and a `TimeoutError` when `timeoutMs` passes before an answer comes. A deadline that passes while an answer's body is being read throws no `TimeoutError`: a refusal then throws `EmailApiError` with `type` `unknown`, and an accepted send resolves with an empty `messageId`. The key is trimmed at each send. A key, an `idempotencyKey` or a `userAgent` that holds a character an HTTP header cannot carry (a line break or another control character other than a tab, or a character above U+00FF) throws an `Error` before any request, and its message names which one and none of its value. `ResendTransport.send` checks a message's `headers` by the rules for names and values in [header fields](#header-fields), though not against the fields the service writes, and throws the same way.

A send is tried again only on the terms of Resend's [errors](https://resend.com/docs/api-reference/errors) and [rate limit](https://resend.com/docs/api-reference/rate-limit) pages, as `retryWaitSeconds` decides:

- `rate_limit_exceeded` (429): always, since nothing was sent;
- `concurrent_idempotent_requests` (409) and any 5xx, such as `application_error` (500) and `service_unavailable` (503): only when the send has an `idempotencyKey`, so a retry cannot deliver twice;
- never `daily_quota_exceeded` or `monthly_quota_exceeded` (both 429), `validation_error`, `invalid_idempotent_request` or any other 4xx.

The wait is the answer's `retry-after` when it has one, else as many seconds as the retry's number: one, then two. A send makes at most `maxRetries` retries, and a wait that would pass the deadline is not taken: the refusal is thrown instead.

## Reading mail

`readInbox`, `searchEmails`, `extractCodes` and `replyToEmail` read through IMAP: the `imap` account (`host`, `user` and `password`, with `port` and `secure`, by default TLS on port 993), or the SMTP account when `imap` is not given. With Resend, reading needs `imap`. The pack's factory reads the account from the secrets `email.imap.host`, `email.imap.user` and `email.imap.password`, or from `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD`.

`searchEmails` finds the messages whose subject, body or From holds `query`, ignoring case, and gives the last `limit` it finds (20 by default), newest first. Each search answers UIDs, and the messages are fetched by those UIDs, which need not follow the messages' sequence numbers once a message has been removed ([RFC 3501 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc3501#section-2.3.1.1)).

`extractCodes(messageId, pattern?)` and `replyToEmail(messageId, body, html?)` name an INBOX message by its Message-ID, with or without its angle brackets: `<id@example.com>` and `id@example.com` name the same message. An IMAP search matches every Message-ID that holds the text ([RFC 3501 section 6.4.4](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.4)), so each searches for the id in angle brackets and takes only the message whose own id is that one. `extractCodes` answers no codes for an id that is not one message id or that no message has.

A reply goes out through the transport that sends:

- to the original's Reply-To, or its From when it names none ([RFC 5322 section 3.6.2](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.2));
- under the original's subject on one line, with `Re: ` before it unless it starts with `Re:` in any case;
- threaded as [RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4) has it: `In-Reply-To` names the original, and `References` lists the ids of the original's own References, or the one id of its In-Reply-To when its References lists none, then the original's id. Only fields of those very names are read, each whole however it is folded. An id in them that holds a character outside printable US-ASCII, or that is too long for one line, is left out, so whatever the original holds, both transports send the same reply.

`replyToEmail` throws an `Error` that holds none of the id when the id is not one message id of printable US-ASCII with no space, or is too long for one line of `In-Reply-To`, before the original is read; and when no message in INBOX has the id, or the original names no address to reply to, before anything is sent.

## In an agent

`createExtensionPack(context)` returns five tools, `emailSend`, `emailRead`, `emailSearch`, `emailExtractCodes` and `emailReply`, and the messaging channel `emailChannel`. Its options (`smtpHost`, `smtpUser`, `smtpPassword`, `smtpPort`, `smtpSecure`, `imapHost`, `imapUser`, `imapPassword`, `imapPort`, `imapSecure`, `resendApiKey`, `resendBaseUrl`, `from`) take precedence over the secrets and the environment variables named above. `manifest.json` lists the SMTP secrets as required, and the IMAP secrets and `email.resendApiKey` as optional.

A model names the tools' arguments and the channel's blocks, so `emailSend` and `emailChannel` pass on an attachment only as `content`, a `data:` address or, through Resend, an `http` or `https` address. They refuse any other before anything is sent, reading no file and fetching no address: the tool answers `{ success: false, error }`, the adapter throws an `Error`, and the message names the attachment's filename, never its path.

They send each attachment as they checked it: a copy of its own `filename`, `content`, `path` and `contentType`, each read once, with a Buffer's bytes copied. They refuse the same way an attachment that is not an object, one that gives any of those four through a getter or a setter, and one whose `filename` or `contentType` is not a string. Any other property of an attachment is left out.

The subject, the bodies and the message id a reply names must be text. Through SMTP, nodemailer reads the file or fetches the address an object body names into the message, and writes an object subject or message id marked `prepared` into the headers as it is. So `sendEmail` and `replyToEmail`, whoever calls them, throw a `TypeError` that names the field, never its value, before anything is sent on either transport: `subject`, `body` and the reply's `messageId` must be strings, and `html` a string when given (`null` leaves the HTML part out). `emailSend` and `emailReply` answer it as `{ success: false, error }`, and the adapter throws it. A reply whose message id is not one message id, or names no message in INBOX, is answered and thrown the same way, with the `Error` [reading mail](#reading-mail) describes.

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
