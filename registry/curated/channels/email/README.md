# @framers/agentos-ext-channel-email

Email for AgentOS. `EmailService` sends mail through SMTP or Resend's HTTPS API, and reads, searches, extracts codes from, replies to, moves, labels, flags and deletes mail through IMAP. The pack's factory wraps the service in a messaging-channel adapter and five tools for an agent. Two stores on a host's SQL database keep what a sender reads before a send: a suppression record and the tokens of unsubscribe links. With its `unsubscribe` option, every mail the service sends carries an unsubscribe link and RFC 8058's one-click fields and reads the suppression record first, and `createUnsubscribeHandler` answers the link ([unsubscribe on every mail](#unsubscribe-on-every-mail)).

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

Each message goes out as `POST /emails` with the key as the bearer and the text and HTML parts in the same call, and `messageId` is the id Resend gives the email, or the empty string when an accepted answer names none or its body cannot be read: a 2xx means the email was sent, so the send never fails after one. A refusal that is tried again repeats the same request, with the same key and any `Idempotency-Key`, so one send makes at most `maxRetries + 1` requests. `idempotencyKey` is sent as Resend's `Idempotency-Key` header: another request under the same key within 24 hours delivers nothing more ([idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)). It is text of 1 to 256 characters with no white space at either end, and free of personal data: `sendEmail` and `ResendTransport.send` refuse any other key before any request, since Resend answers a key outside that length with 400 `invalid_idempotency_key` and `fetch` strips white space at either end of a header value, so `k ` and `k` would share one key. `null` is no key. SMTP sends no key.

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

`headers` adds fields and never replaces the service's own: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and every `Content-` field are refused, in any case. The recipients, the reply-to and the subject have their own options, and the From comes from the configuration's `from`. A name given twice in different cases is refused too. A refusal throws an `Error` before either transport is used, naming the field, or its place in the object when its name is at fault, and none of its value. The `emailSend` tool and the channel adapter add no header fields of their own. With `unsubscribe` configured the service writes `List-Unsubscribe` and `List-Unsubscribe-Post` itself, on every send and reply, and a send that gives either is refused ([unsubscribe on every mail](#unsubscribe-on-every-mail)).

The subject goes out on one line through both transports: each line break in it, and each other control character but the tab, is sent as a space, as nodemailer writes a line break in a subject.

## A mail your product renders

A product that keeps its own templates, its own unsubscribe tokens and its own once-only record of each mail sends through a service with no `unsubscribe` configuration. The service then adds nothing: the subject (on one line), both parts and the header fields go out as given, and the product's own RFC 8058 pair carries its link.

```ts
import { EmailService } from '@framers/agentos-ext-channel-email';

const email = new EmailService({
  resend: { apiKey: () => process.env.RESEND_API_KEY ?? '' },
  from: 'Example <billing@example.com>',
});
await email.initialize();

// One row of the product's once-only record: the mail as its first attempt posted it.
const { messageId } = await email.sendEmail({
  to: row.to,
  subject: row.subject,
  body: row.text,
  html: row.html,
  headers: {
    'List-Unsubscribe': '<https://example.com/api/mail/unsubscribe?t=opaque-token>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
  idempotencyKey: row.id,
});
```

- Key the send with the record's id and post, on every retry, the request the first attempt posted. The same options give the same request, field for field and in the same order. Resend answers a repeat of a key within 24 hours with the first send's answer and delivers nothing more, and answers a changed payload under a key it has seen with 409 `invalid_idempotent_request` ([idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)).
- A `TypeError` (the connection failed) or a `TimeoutError` (the deadline passed) leaves it unknown whether Resend took the mail: retry under the same key while the 24 hours last. Past them a retry can deliver the mail twice.
- An `EmailApiError` that refuses the request itself ends the retries, since the same request is refused again: `invalid_idempotent_request` (409), a `validation_error` with `status` 400 (the transport sends no key Resend cannot read, so this is a field of the request), and a 422 such as `invalid_parameter` or `missing_required_field`. A 401 or 403 is the account's and not the mail's: a `validation_error` with `status` 401 is a key Resend does not know, one with `status` 403 a sending domain that is not verified, and `restricted_api_key` or `suspended_api_key` a key that may not send ([errors](https://resend.com/docs/api-reference/errors)). Resend sent nothing, so once the account is fixed the same request can be retried under the same key while the 24 hours last; read `status` as well as `type` before ending a mail's retries. A `rate_limit_exceeded`, a `concurrent_idempotent_requests` or a 5xx the transport could not clear inside its deadline can be retried later under the same key.
- `messageId` is the empty string when Resend took the mail but its answer named no id: record the mail as sent.
- A mail sent without header fields posts no `headers` field at all, so a record whose first attempt carried none is posted again in that shape.

## Suppressions and unsubscribe tokens

Two stores a sender reads, each on the host's SQL database: `SqlSuppressionStore` keeps the addresses not to mail, each named by a hash of it, such as its SHA-256, and `SqlRecipientCapability` keeps opaque tokens, such as an unsubscribe link's, each naming a recipient and a scope. Both take [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter)'s adapter on SQLite or PostgreSQL, or any handle with its `run` and `get` (`?` placeholders, positional parameters), so the pack gains no dependency. The handle answers each `get` from the database: one that answers from a cache of its earlier reads can answer a row as it stood before a later write, so `find` could still answer a token after its `revoke`. Two such handles are the adapter's deprecated `SupabaseAdapter` after `enableCache()`, and an adapter a host builds on the adapter's `BaseStorageAdapter` at its default performance tier, `balanced`, which keeps each read for five seconds: give such an adapter the tier `accurate`, which keeps none. A handle's `run` answers `changes`, the rows the statement wrote. A handle whose answer holds no such count, because it leaves `changes` out or gives something other than a whole number of 0 or more (the adapter's Capacitor handle gave an object before 0.6.14), still records, issues and revokes, but `suppress` then answers `false` and `revoke` 0, whatever they wrote.

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

`suppress(scope, addressHash, reason, day)` records an address in a scope with its reason and its day (`YYYY-MM-DD`), and no end: the store has no call that lifts an address, so an operator lifts one by deleting its row through the same handle, as in `await db.run('DELETE FROM mail_suppressions WHERE scope = ? AND address_hash = ?', [DEFAULT_SUPPRESSION_SCOPE, addressHash])` for the example's prefix `mail`. The `?` placeholders are the adapter's, which binds the values given and on PostgreSQL writes `$1` and `$2` in their place. In a console, write the scope and the hash as quoted literals instead: PostgreSQL reads a `?` as an operator and refuses the statement, and the sqlite3 shell binds a `?` to NULL, so the statement deletes nothing. The reason is `bounce`, `complaint`, `suppressed` (the provider refused a message because its own list held the address) or `manual`. A second record of the address in the scope writes nothing and keeps the first, so a provider's repeated event is harmless; `suppress` answers `true` only for the call that recorded it, and two hosts recording one address at once leave one row. `isSuppressed(scope, addressHash)` answers for one scope. A scope is one list, and a host that keeps one passes `DEFAULT_SUPPRESSION_SCOPE` (`mail`) everywhere. `addressHash` is the address's hash as 64 lower-case hexadecimal characters, such as its SHA-256, which the host computes the same way wherever it reads or writes the record. Any other value, an address among them, throws a `TypeError` that holds none of it, so a mistake stores nothing and is never answered as not suppressed. The store takes any 64 lower-case hexadecimal characters, so the host chooses the hash. A plain SHA-256, as in the example, lets anyone who holds the table check an address they guess against it; a host that wants the table to tell nothing of an address it does not already hold computes HMAC-SHA256 under a secret key of its own instead, the same way at every reader and writer. `SUPPRESSION_REASONS` lists the four reasons, and it is frozen, since `suppress` checks a reason against it.

`issue(recipient, scope, nonce, key)` answers base64url of HMAC-SHA256 over the nonce under the key, 43 characters, and stores the token's SHA-256 beside the recipient and the scope: the token carries neither, and the table holds nothing it can be recovered from. The same nonce under the same key gives the same token, so each message takes a nonce of its own, such as its id. Issuing it again for the same recipient, scope and expiry writes nothing; for another recipient, scope or expiry it throws, and the first token keeps all three. The key is 32 random bytes or more, given as a `Uint8Array` or a `Buffer` and kept secret, such as `crypto.randomBytes(32)` stored with the host's other secrets; the store cannot judge how random a key is. A key made in another realm, such as a `vm` context or a test runner's sandbox, is taken as the same bytes made here. A different key gives different tokens for the same nonces, and the same key the same tokens, whatever the prefix: the prefix keeps two hosts' tables apart, not their tokens. Two hosts on one database that share a key and use one nonce draw one token, and each one's `find` answers its own row for it, so a link one host sent could act on the other host's recipient. Each host takes a key of its own, or nonces no other host uses, such as its own name before each message id. `find(token)` answers the recipient and the scope, or `null` for a token that is malformed, unknown, revoked or past its expiry: it looks the token up by its SHA-256 and compares in constant time. `revoke(recipient)` ends every token of the recipient, in every scope, and answers how many it marked: each of the recipient's tokens not revoked before, one past its expiry among them. Each revoked row stays, marked with the time of the revoke, so `issue` refuses a revoked token's nonce for every recipient, scope and expiry: a revoked link never works again and never comes to name someone else. A message that needs a working token after a revoke takes a new nonce, and the token it gets works. A token has no expiry unless `issue`'s options set `expiresAt`, in epoch milliseconds.

`suppressionStoreDdl(prefix)` makes the table `<prefix>_suppressions` (`scope`, `address_hash`, `reason`, `suppressed_on`), `recipientCapabilityDdl(prefix)` makes `<prefix>_capabilities` (`token_hash`, `recipient`, `scope`, `expires_at`, `revoked_at`) with its index on the recipient, and `emailPreferencesDdl(prefix)` makes both. The prefix is a lower-case letter and at most 39 lower-case letters, digits or underscores; any other value throws a `RangeError` from the DDL functions and both constructors. The prefix keeps two hosts' tables apart on one database. On SQLite, take a prefix other than `sqlite` and those beginning `sqlite_`: their tables would begin `sqlite_`, names SQLite keeps for its own tables, so its `CREATE TABLE` refuses them ([CREATE TABLE](https://www.sqlite.org/lang_createtable.html)) and every call of a store on such a prefix then fails on the missing table. PostgreSQL makes them. The statements are `CREATE ... IF NOT EXISTS`, so a migration can run them again, and they run on SQLite and PostgreSQL, from one process at a time: PostgreSQL does not promise that two `CREATE TABLE IF NOT EXISTS` of one new table at once both succeed, and one of them can fail on a duplicate key in `pg_type` (pgsql-hackers, 9 October 2018: [the report](https://www.postgresql.org/message-id/93336f06-86c2-71b6-abe3-0d42cc614b2b%40postgrespro.ru) and [the reply](https://www.postgresql.org/message-id/22700.1539093909%40sss.pgh.pa.us)). A host whose processes start together runs them in a migration, such as the adapter's `runSchemaMigrations` (0.7.2 or later), which takes an advisory lock on PostgreSQL. A token's row refuses its nonce for as long as it stays, revoked or not. A host that deletes a recipient's rows, by its own foreign key with `ON DELETE CASCADE` or by hand, never issues their nonces again: each message's nonce is one no other message ever had, such as a random id or a row id that is never reused. A host that cannot promise that calls `revoke` with each deletion and keeps the rows. Each store checks every argument before its first statement. A scope, a recipient and a nonce are strings of 1 to 512 UTF-16 code units (JavaScript's `length`, in which a character past U+FFFF counts two) with no U+0000, which PostgreSQL's text refuses, and no lone surrogate, which UTF-8 cannot encode, so a driver would store something else in its place: any other value throws a `TypeError` that holds none of it, and a name is stored as given on every backend. A database error passes through as it was thrown. A store made on the handle that the adapter's `transaction` gives its callback writes inside that transaction. On a server, open the database as the example does, with the adapter's `strict` option (0.6.15 or later): without it, a `url` that is unset opens a local SQLite database in its place, and the record a sender reads before each send would live there.

## Unsubscribe on every mail

```ts
import { createDatabase } from '@framers/sql-storage-adapter';
import {
  EmailService,
  SqlRecipientCapability,
  SqlSuppressionStore,
  createUnsubscribeHandler,
  emailPreferencesDdl,
} from '@framers/agentos-ext-channel-email';

const db = await createDatabase({ url: process.env.DATABASE_URL, strict: true });
await db.exec(emailPreferencesDdl('mail'));
const tokens = new SqlRecipientCapability(db, 'mail');
const suppressions = new SqlSuppressionStore(db, 'mail');

const email = new EmailService({
  resend: { apiKey: process.env.RESEND_API_KEY ?? '' },
  from: 'Example <hello@example.com>',
  unsubscribe: {
    pageUrl: 'https://example.com/email/unsubscribe',
    mailto: 'unsubscribe@example.com',
    tokens,
    suppressions,
    key: Buffer.from(process.env.UNSUBSCRIBE_KEY ?? '', 'hex'), // 32 random bytes or more, kept secret
    postalAddress: 'Example LLC, 1 Example Street, Example City, EX 00000',
  },
});
await email.initialize();

// Optional mail names its category: its link stops that category.
await email.sendEmail({ to: 'reader@example.com', subject: 'Your week', body: 'Plain words.', category: 'weekly-summary' });
// Mail a person cannot turn off is required: its link turns off every optional mail.
await email.sendEmail({ to: 'reader@example.com', subject: 'Your receipt', body: 'Paid.', required: true });

// The route at the page's path, such as a Next.js route handler in app/email/unsubscribe/route.ts.
const unsubscribe = createUnsubscribeHandler({ tokens, suppressions, productName: 'Example', deleteAccountUrl: '/settings/account' });
export const GET = unsubscribe;
export const POST = unsubscribe;
```

With `unsubscribe` configured, every mail the service sends carries a link of its own, through `sendEmail`, `replyToEmail`, the `emailSend` and `emailReply` tools and the channel adapter alike:

- `List-Unsubscribe` names the link, then `mailto:` with the subject `unsubscribe` when `mailto` is given, and `List-Unsubscribe-Post` is `List-Unsubscribe=One-Click`, the two fields of a one-click unsubscribe ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)). Through Resend they go in the request's `headers` ([custom headers](https://resend.com/docs/dashboard/emails/custom-headers)); through SMTP nodemailer writes them as it writes other added fields. A receiver acts on the pair only when the message's DKIM signature covers both ([RFC 8058 section 4](https://www.rfc-editor.org/rfc/rfc8058#section-4)). Resend's pages do not say which fields its signature lists, so read the `h=` tag of the `DKIM-Signature` of a mail received from the sending domain before relying on one-click there.
- The text part ends with a blank line, `Unsubscribe: ` and the link, and the postal address on the next line when one is configured. The HTML part gets a paragraph in 13-pixel text, the smallest a reader is asked to read at a phone's width, before its last closing body tag, or at its end when it has none: the link, underlined, and the postal address under it. The part is read as the HTML standard's tokenizer reads it, and a test checks the placement against parse5: a `</body>` inside a comment, an attribute's value, a doctype, a template or an element whose content is text (a script, a style, a title or a textarea) is no tag, and a template or anything of these the part leaves open at its end gets the footer before it. Three limits stand: an element the part leaves open around that place, such as a hidden `div` or a `select` with no end tag, holds the footer too; inside an `svg` or a `math` a style's or a title's content is taken as text and a CDATA section as a declaration, so an inline `svg` that leaves a comment open in its style can hide the footer; and a frameset page has no body to hold it, which no mail client renders. A part that holds `{{unsubscribe_url}}` (`UNSUBSCRIBE_URL_MARKER`) in its text or a tag's attribute, such as a link's `href`, gets the link in place of each and no footer, so a branded template places the link itself and keeps it legible. A marker only in a comment, a doctype, a script, a style, a title, a textarea, a template or a tag left open is written as the link too, and the part still gets the footer, since a reader sees none of those; commercial mail whose part does not hold the postal address then gets it after the part's text.
- The link is `pageUrl` with `?t=` and a token of 43 characters that `tokens.issue` draws for the recipient's address hash and the list the link writes. It names nothing else: no address, account, category or time can be read from it, and `tokens` keeps only its SHA-256. The send's `idempotencyKey`, when it has one, is its nonce (as `send:` and the key), so a retry carries the same link; otherwise each send draws a new one.

A send says what kind of mail it is, and each kind reads its own lists before anything is drawn or sent:

| The send | The lists it reads, in order | Its link writes |
|---|---|---|
| `required: true`, and every reply | `do-not-contact` (`DO_NOT_CONTACT_SCOPE`) | `optional` (`OPTIONAL_MAIL_SCOPE`): every optional mail |
| `category: 'weekly-summary'` | `do-not-contact`, `mail` (`DEFAULT_SUPPRESSION_SCOPE`, the provider's bounces and complaints), `optional`, `optional:weekly-summary` | `optional:weekly-summary` (`categoryScope('weekly-summary')`) |

An address on a list its send reads rejects the send with `EmailSuppressedError`, whose `code` is `suppressed` and whose `scope` names the list, before a token is drawn or anything is sent; its message names the list and never the address. The `emailSend` tool answers it as `{ success: false, error }`, and the channel adapter throws it. The record names an address by `addressHash` of the address trimmed and lower-cased: its SHA-256 in lower-case hexadecimal unless the configuration gives a function of its own, which every other writer of the record then uses too. That function answers 64 lower-case hexadecimal characters, the name the route reads a link's recipient by; a send whose address it names any other way throws a `TypeError` that holds neither, before any list is read, so no mail goes out with a link that stops nothing. The do-not-contact list is the operator's: `await suppressions.suppress(DO_NOT_CONTACT_SCOPE, addressHash, 'manual', '2026-11-04')` stops every mail to the address, required mail and replies included, and a host writes its standing do-not-contact addresses there before its first send.

- `category` is a lower-case letter, then at most 63 lower-case letters, digits, hyphens or underscores, and optional mail must name one. `required: true` marks mail a person cannot turn off: sign-in codes, receipts, security and legal notices, and mail to the team's own address, such as an operations alert. `commercial: true` marks advertising, which is never required and is refused unless the configuration gives `postalAddress`, since CAN-SPAM asks commercial mail for the sender's valid physical postal address ([15 U.S.C. 7704(a)(5)](https://www.law.cornell.edu/uscode/text/15/7704)).
- A send goes to one address, `reader@example.com` or `Reader <reader@example.com>`, with no `cc` or `bcc`, since a link names one recipient, and gives no `List-Unsubscribe` or `List-Unsubscribe-Post` of its own. Anything else throws before anything is read, drawn or sent. The recipients, the reply-to, the idempotency key and the attachments are read once, before anything is awaited, so the address whose lists were read and whose link was drawn is the one the message goes to, even when the caller changes the options object while the send waits. Without `unsubscribe`, a `category`, a `required: true` or a `commercial: true` throws the same way, so no send is taken for one that carries a link.
- The `emailSend` tool and the channel adapter send under `agentCategory`; `emailReply` and `replyToEmail` send as required mail does, so a person who turned off every optional mail still gets the answer to a message they wrote, and an address on the do-not-contact list gets none. A reply reads the do-not-contact list for the address it goes to and for every address the original names in its From, Sender and Reply-To, so a person on the list who writes with another Reply-To gets no reply either.

| `unsubscribe` option | Default | What it sets |
|---|---|---|
| `pageUrl` | required | The page each link opens and the address of the one-click POST: https, no query, fragment or credentials, 900 characters at most |
| `mailto` | none | An address at the sender that takes unsubscribe requests by mail, listed after the link; leave it out when nothing reads that mailbox |
| `tokens` | required | Where the tokens are drawn, such as `SqlRecipientCapability`; the route finds them there |
| `suppressions` | required | The suppression record each send reads, such as `SqlSuppressionStore`; the route writes it |
| `key` | required | The key the tokens are drawn under, 32 random bytes or more, or a function that answers it at each send so a rotated key applies at once |
| `retiredKeys` | none | The keys tokens were drawn under before `key`, or a function that answers them at each send. List a rotated key while a send under an idempotency key may still be retried, 24 hours through Resend: the retry finds the token its first attempt drew and carries the same link, since Resend answers a changed payload under the same key with 409 `invalid_idempotent_request` ([errors](https://resend.com/docs/api-reference/errors)) |
| `addressHash` | SHA-256 in hex | How the record names an address, given the address trimmed and lower-cased |
| `postalAddress` | none | The sender's postal address on one line, 300 characters at most, at the foot of every mail; commercial mail is refused without it |
| `agentCategory` | `conversation` | The category of the mail the `emailSend` tool and the channel adapter send |
| `linkText` | `Unsubscribe` | The words of the footer's link |

Each option is checked when the service is made, and one that does not fit throws a `TypeError` that names it and holds none of its value. The pack's factory takes the same object as its option `unsubscribe`.

`createUnsubscribeHandler(options)` is the route the link opens: a function from a web `Request` to a `Response`, mounted at `pageUrl`'s path on any server on Node.js that speaks them, such as a Next.js route handler on the Node.js runtime. The route reads the request with web APIs alone; the package it ships in loads Node's modules. It holds no transport, so an unsubscribe is never answered by a mail.

- A GET or a HEAD shows a page that asks and changes nothing, since link scanners follow links. A category's link offers a button that stops the category and one that turns off every optional mail; a required mail's link offers one button that turns off every optional mail, says what still comes and why (sign-in codes, receipts, replies to mail the reader writes, and security and legal notices), and links to `deleteAccountUrl` when it is given. The page loads nothing, runs no script, reads at 16 pixels with 44-pixel buttons, and follows the reader's light or dark setting. A token that finds nothing answers 404 with a page that says so.
- A POST suppresses at once, with the reason `manual` on the day `now` reads, and depends on nothing but the token in its address. A mailbox provider's one-click POST, or any POST that names no `choice`, writes the link's own list and answers a blank 200, never a redirect ([RFC 8058 section 3.2](https://www.rfc-editor.org/rfc/rfc8058#section-3.2)). The page's buttons post `choice=this` or `choice=all` as a form and get the page that says what was done; `all`, and every required mail's link, writes `optional`. A form longer than 4,096 bytes counts as a one-click POST. A token that finds nothing, or one drawn for a list that is no unsubscribe list, writes nothing and gets the same blank 200, or the 404 page from a button.
- Any other method answers 405 with `Allow: GET, HEAD, POST`. Every answer carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, as the address carries the token, and a page a `Content-Security-Policy` that loads nothing and posts only to its own origin. An error of a store passes through as it was thrown, so the server answers 500 and a mailbox provider tries again.

| Route option | Default | What it sets |
|---|---|---|
| `tokens`, `suppressions` | required | The stores the service draws in and reads |
| `productName` | none | The sender's name, above the page's heading |
| `categoryNames` | each category with its hyphens and underscores as spaces | The words a page names each category by, such as `{ 'weekly-summary': 'weekly summary' }`; a category it leaves out, `constructor` included, gets the default |
| `deleteAccountUrl` | none | An https address or a path, linked on a required mail's page |
| `now` | `Date.now` | The clock each suppression's day is read from |
| `render` | the route's own page | Writes the page from the view: `{ state: 'ask', category, token }`, `{ state: 'done', category, all }` or `{ state: 'invalid' }`, `category` `null` for a required mail's link |

## Errors and retries

A refusal from Resend throws `EmailApiError`, with `status` (the HTTP status), `type` (Resend's error name, such as `validation_error`, or `unknown` when the answer's body is not JSON, names no error, or names one that is not 1 to 64 letters, digits, `_`, `.`, `:` or `-`) and `retryAfterSeconds` (the answer's `retry-after`, or `null`). Its message names the status and the type and never carries Resend's message, which can quote an address.

`fetch`'s own errors pass through as it throws them: a `TypeError` when the connection fails, and a `TimeoutError` when `timeoutMs` passes before an answer comes. A deadline that passes while an answer's body is being read throws no `TimeoutError`: a refusal then throws `EmailApiError` with `type` `unknown`, and an accepted send resolves with an empty `messageId`. The key is trimmed at each send. A key, an `idempotencyKey` or a `userAgent` that holds a character an HTTP header cannot carry (a line break or another control character other than a tab, or a character above U+00FF) throws an `Error` before any request, and its message names which one and none of its value. So does a key that is not a bearer token as [RFC 6750 section 2.1](https://www.rfc-editor.org/rfc/rfc6750#section-2.1) writes it (letters, digits and `-`, `.`, `_`, `~`, `+` and `/`, with any `=` at its end), such as a key still in its quotes or after its setting's name: Resend answers an `Authorization` header that is not a valid key with 400 `validation_error`, the answer it gives a field it cannot take, and a key of that form it does not know with 401 ([errors](https://resend.com/docs/api-reference/errors)). So does an `idempotencyKey` that is not text of 1 to 256 characters with no white space at either end (`requireIdempotencyKey`). `ResendTransport.send` checks a message's `headers` by the rules for names and values in [header fields](#header-fields), though not against the fields the service writes, and throws the same way.

A send is tried again only on the terms of Resend's [errors](https://resend.com/docs/api-reference/errors) and [rate limit](https://resend.com/docs/api-reference/rate-limit) pages, as `retryWaitSeconds` decides:

- `rate_limit_exceeded` (429): always, since nothing was sent;
- `concurrent_idempotent_requests` (409) and any 5xx, such as `application_error` (500) and `service_unavailable` (503): only when the send has an `idempotencyKey`, so a retry cannot deliver twice;
- never `daily_quota_exceeded` or `monthly_quota_exceeded` (both 429), `validation_error`, `invalid_idempotent_request` or any other 4xx.

The wait is the answer's `retry-after` when it has one, else as many seconds as the retry's number: one, then two. A send makes at most `maxRetries` retries, and a wait that would pass the deadline is not taken: the refusal is thrown instead.

## Reading mail

`readInbox`, `searchEmails`, `extractCodes` and `replyToEmail` read through IMAP: the `imap` account (`host`, `user` and `password`, with `port` and `secure`, by default TLS on port 993), or the SMTP account when `imap` is not given. With Resend, reading needs `imap`. The pack's factory reads the account from the secrets `email.imap.host`, `email.imap.user` and `email.imap.password`, or from `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD`.

`readInbox(folder?, limit?)` gives the last `limit` messages of `folder`, newest first: INBOX and 20 when they are not given; given one object instead, it can read after a UID ([the read surface](#the-read-surface)). `searchEmails({ query, folder?, since?, limit? })` finds the messages whose subject, body or From holds `query`, ignoring case, received on or after the day `since` names when it is given, and gives the last `limit` it finds (20 by default), newest first. Each search answers UIDs, and the messages are fetched by those UIDs, which need not follow the messages' sequence numbers once a message has been removed ([RFC 3501 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc3501#section-2.3.1.1)).

`limit` is a whole number of at least 1. `since` is an ISO 8601 date, such as `2026-10-15`, alone or followed by a time and an offset, such as `2026-10-15T09:30:00-05:00`. The search finds the messages the server received on the day the date names, as written, or later, the time of day disregarded ([RFC 3501 section 6.4.4](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.4)), on every server: the time and the offset are checked, then disregarded, and imapflow is given the day as text, which it sends as `SINCE` and that day. Given a `Date`, imapflow would search a server that announces `WITHIN` from that moment, to the second ([RFC 5032 section 2](https://www.rfc-editor.org/rfc/rfc5032#section-2)), and any other server from its day in UTC.

`limit` and `since` count as not given when they are `undefined` or `null`, and `since` also when it is empty. Any other `limit` or `since` throws an `Error` before any mail is read: the fetch would otherwise name a message past the last one, which a server answers `BAD`, and imapflow leaves a date it cannot read out of the search, which then answers mail of every date. The refused `since` values include a number, text in another form such as `October 15, 2026`, which `Date` reads by guesswork and in the local time zone, and a day its month lacks such as `2026-02-30`, which `Date` reads as 2 March.

Each message read carries its `messageId`, the first address of its `from` and of its `to`, its `subject`, `date`, `body`, `flags` and `uid`, and the fields [the read surface](#the-read-surface) lists. `date` is the message's Date field in ISO 8601, or the empty string when it has none or the field does not read as a date, so one such message never fails the read.

`extractCodes(messageId, pattern?)` and `replyToEmail(messageId, body, html?)` name an INBOX message by its Message-ID, with or without its angle brackets: `<id@example.com>` and `id@example.com` name the same message. An IMAP search matches every Message-ID that holds the text ([RFC 3501 section 6.4.4](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.4)), so each searches for the id in angle brackets and takes only the message whose own id is that one. `extractCodes` answers no codes for an id that is not one message id or that no message has.

`extractCodes` searches the message's plain part and its HTML part, each tag of the HTML (a `<`, at least one character, and the first `>` after it) written as a space, and answers each code once: the matches of `pattern` when it is given, else runs of four to eight digits, then the codes that phrases such as "code is", "OTP:", "is your" or "enter ... to" point to. `pattern` is a JavaScript regular expression, compiled with the `g` flag. A code is each match's first group, or the whole match when that group takes no part in it; an empty one is no code, and a match of empty text moves the search on by one character. A `pattern` that is `undefined`, `null` or empty counts as not given. One that is not a string, or that does not compile, throws an `Error` before any mail is read. The pattern runs over the message for at most 250 ms, timed by Node's `vm` module, which V8 honours at each step back a regular expression takes: one that runs longer, as a pattern that backtracks without end such as `(\d+)+$` can, throws an `Error` naming the limit. The limit holds however long the message, so a slow pattern over a very large message reaches it too. The `vm` module serves as a timer there, not as a sandbox: a regular expression runs no code of its own.

A reply goes out through the transport that sends:

- to the original's Reply-To, or its From when it names none ([RFC 5322 section 3.6.2](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.2));
- under the original's subject on one line, with `Re: ` before it unless it starts with `Re:` in any case;
- threaded as [RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4) has it: `In-Reply-To` names the original, and `References` lists the ids of the original's own References, or the one id of its In-Reply-To when its References lists none, then the original's id. Only fields of those very names are read, each whole however it is folded. An id in them that holds a character outside printable US-ASCII, or that is too long for one line, is left out, so whatever the original holds, both transports send the same reply.

`replyToEmail` throws an `Error` that holds none of the id when the id is not one message id of printable US-ASCII with no space, or is too long for one line of `In-Reply-To`, before the original is read; and when no message in INBOX has the id, or the original names no address to reply to, before anything is sent.

## The read surface

A host that files the mail a mailbox receives, such as a support desk, reads by UID and acts on each message by its UID:

```ts
import { EmailMailboxError } from '@framers/agentos-ext-channel-email';

// The last UID filed and the folder's UIDVALIDITY when it was read, which the host keeps.
let cursor = { uid: 0, uidValidity: '' };
const mails = await email.readInbox({ afterUid: cursor.uid, uidValidity: cursor.uidValidity, limit: 50, authServId: 'mx.example.com' });
for (const mail of mails) {
  const picture = mail.attachments.find((attachment) => attachment.type === 'image/png');
  const bytes = picture === undefined ? undefined : await picture.read(5_242_880);
  // File mail.text and bytes, then remove the mailbox's copy; a copy already gone counts as removed.
  await email.deleteMessage(mail.uid).catch((error: unknown) => {
    if (!(error instanceof EmailMailboxError && error.code === 'gone')) throw error;
  });
  cursor = { uid: mail.uid, uidValidity: mail.uidValidity };
}
```

`readInbox({ folder?, limit?, afterUid?, uidValidity?, maxBytes?, authServId? })` reads as `readInbox(folder, limit)` does: the last `limit` messages, newest first. With `afterUid` it gives the first `limit` messages whose UID is greater, oldest first, whatever their flags, so a cursor that keeps the last UID filed moves forward without skipping a message. A FETCH response the server sends unasked during a read, such as the flags another session changed ([RFC 3501 section 7.4.2](https://www.rfc-editor.org/rfc/rfc3501#section-7.4.2)), is no message of the read. It searches `UID <afterUid + 1>:*` and keeps the greater UIDs alone, since a range ending in `*` names the last message even when its UID is not greater ([RFC 3501 section 9](https://www.rfc-editor.org/rfc/rfc3501#section-9)). `afterUid` is a whole number from 0. A UID names the same message only while the folder's UIDVALIDITY holds ([RFC 3501 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc3501#section-2.3.1.1)), so each message gives the folder's `uidValidity`, and given it beside `afterUid`, a read of a folder whose UIDVALIDITY is another starts from the folder's first message, since its UIDs were given anew. `uidValidity` is a whole number from 1 to 4,294,967,295, or its digits with no leading zero; `null` and the empty string count as not given. `searchEmails` takes `maxBytes` and `authServId` too, and gives the same fields.

Each message `readInbox` and `searchEmails` give carries, beside `messageId`, `from`, `to`, `subject`, `date`, `body`, `flags` and `uid`:

| Field | What it holds |
|---|---|
| `uidValidity` | The folder's UIDVALIDITY when the message was read, in decimal; the empty string when the server gave none. A host that keeps the last UID it read keeps this beside it |
| `key` | The key the mailbox keeps the mail by, the id the server gives where it gives one: the EMAILID ([RFC 8474](https://www.rfc-editor.org/rfc/rfc8474)) where the server offers OBJECTID, else Gmail's X-GM-MSGID where it offers X-GM-EXT-1. On any other server, the folder's name, a space and the Message-ID; else, for a message with no Message-ID, the folder's name, a space, its UIDVALIDITY, a colon and its UID. A sender writes the Message-ID, so on such a server a message that copies another's Message-ID has its key: a host that keeps one mail a key compares the UID there too. A string to compare and store, not to parse |
| `recipients` | Every address the To, Cc and Delivered-To fields name, in lowercase, each once, in that order. A local part is in quotes, as [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322#section-3.4.1) writes it, only when it holds white space, a double quote or another special but the dot, such as `"support team"@example.com`, whether the server gave it with its quoting removed or the field kept it |
| `inReplyTo`, `references` | The first message id In-Reply-To lists, or the empty string, and the ids References lists, each in angle brackets |
| `autoSubmitted` | The Auto-Submitted keyword ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834#section-5)) in lowercase, such as `auto-replied`; `no` when the field is absent |
| `precedence` | The Precedence keyword in lowercase, such as `bulk` or `list`; the empty string when the field is absent |
| `autoreply` | Whether the message carries an X-Autoreply or an X-Auto-Response-Suppress field |
| `isReport` | Whether its own type is `multipart/report` ([RFC 6522](https://www.rfc-editor.org/rfc/rfc6522)), as a delivery or read report's is |
| `authentication` | `dkim`, `spf` and `dmarc`, each result in lowercase, `dmarcFrom`, the domain the DMARC result names, and `alignedDomain`, read from an Authentication-Results field ([RFC 8601](https://www.rfc-editor.org/rfc/rfc8601)) as below; a result the field does not record reads `none` |
| `text`, `html` | The text parts, and the HTML parts, each decoded from its transfer encoding and charset and joined by a line break in their order, as a picture between two of them leaves them; each at most `maxBytes` bytes of UTF-8, cut on a character's edge. Of a `multipart/alternative`'s forms only the first that holds text, or HTML, counts. The empty string when the message has none |
| `truncated` | Whether the text or the HTML held more than `maxBytes` gives |
| `attachments` | Every other part, in the message's order: its `name`, `type`, `bytes` and `read(maxBytes?)` |

`authentication` comes from the topmost Authentication-Results field alone. Each host that checks a message adds its field at the top ([RFC 8601 section 2.1](https://www.rfc-editor.org/rfc/rfc8601#section-2.1) and [section 4](https://www.rfc-editor.org/rfc/rfc8601#section-4)), so the receiving host's field is the topmost and a field an earlier hop or the sender wrote sits below it; no field below the topmost is read. Give `authServId`, the authserv-id of the host that takes mail into the mailbox, such as `mx.google.com`, for any decision that trusts the results; a read that names none reads under the service's own, `EmailConfig.authServId`, when the configuration names one. The topmost field then counts only when it names that host, so a mail whose topmost field names another host, or none, reads `none` throughout. A field that names no authserv-id, as Outlook writes it (`Authentication-Results: spf=pass (sender IP is ...) smtp.mailfrom=example.com; dkim=pass ...`), is read from its first result, since an authserv-id is a token or a quoted string ([RFC 2045 section 5.1](https://www.rfc-editor.org/rfc/rfc2045#section-5.1)) and a bare `=` is part of neither; it counts with no `authServId` and never under one. The results are the topmost field as written. On a host that writes no field of its own, the topmost field is one the sender wrote, and `authServId` cannot tell the two apart; a host that copies a sender's text into its own field unescaped gives that text as results. A host that writes one field per test, as [RFC 8601 section 4](https://www.rfc-editor.org/rfc/rfc8601#section-4) allows, gives its topmost field's results alone, and the results its other fields record read `none`. So read a few real mails' fields on the mailbox before a decision trusts them. An `authServId` that is not text, holds a control character or is white space alone throws an `Error` before any mail is read, and `readHeaderFields` and `parseAuthenticationResults` throw the same; `null` and the empty string count as not given. Comments are left out, so a semicolon inside one splits nothing. `dkim` reads `pass` when any signature passed. `dmarc` is the receiving host's verdict for the domain `dmarcFrom` names, the domain of the From field that host read ([RFC 7489 section 11.1](https://www.rfc-editor.org/rfc/rfc7489#section-11.1)), so a host that trusts `dmarc` compares `dmarcFrom` with the domain of the message's `from`. `alignedDomain` is the From address's domain when a DKIM signature that passed was made for that domain or for a domain it ends in after a dot, its `header.d`, or the domain of its `header.i` where it names no `header.d`; it reads `none` otherwise, and when the From names no domain, as a group's or an absent From's does. A signature made for a domain below the From domain does not count, though the relaxed alignment of [RFC 7489 section 3.1.1](https://www.rfc-editor.org/rfc/rfc7489#section-3.1.1) counts it: finding a domain's organizational domain needs the public suffix list. A host that reads a message's header another way, such as through Gmail's API, reads the same fields with `readHeaderFields(headerBlock, { from, authServId })`, given the header's fields in their order, and the results alone with `parseAuthenticationResults`; given no `from` at all, these align with the domain the DMARC result names.

`maxBytes` is a whole number from 1 to 268,435,456, 262,144 when not given. A read fetches each message's envelope, flags, body structure and the header fields above through `BODY.PEEK`, which marks nothing seen, then its text and HTML parts by UID, each up to the bytes that can decode to what `maxBytes` leaves once the parts before it are read, so a large part is never fetched whole and a part past a filled bound is not fetched. A quoted-printable part written with runs of soft line breaks, which no encoder that keeps to the rules writes, can hold more than four bytes for each byte it decodes to; it reads as truncated, since a read fetches no more of a part than about four times the bound. `body` is `text`, or, for a message with no text part, its HTML with each tag written as a space.

An attachment is every part that is not the message's text or HTML: a part marked an attachment or named as a file, a part of any other type, and a message attached whole (`message/rfc822`), whose own parts are not listed. A text or HTML form a `multipart/alternative` does not take is neither. `bytes` is its size as the server holds it, in its transfer encoding, never less than its decoded bytes: about four thirds of them for base64. No read fetches an attachment's bytes. `read(maxBytes?)` fetches them by the message's UID over a connection of its own and resolves with the decoded bytes. It rejects with `EmailMailboxError` `too_large`, having fetched at most the bytes that could decode to the bound, when they pass `maxBytes`, a whole number from 1 to 268,435,456, 26,214,400 when not given, or when the part holds more bytes in its transfer encoding than decode to the bound from an encoder that keeps to its rules: twice the bound for base64, four times for quoted-printable. Since `bytes` counts the transfer encoding, a host that bounds an attachment's decoded size passes that bound to `read` and catches `too_large`. It rejects with `gone` when the folder no longer holds the message or its UIDVALIDITY changed since the read, and with `refused` when the server will not open the folder, as when it was deleted or renamed since the read.

### Changes by UID

Each change acts on one message by its UID in `folder`, INBOX when not given, over a connection of its own:

- `moveTo(uid, destination, { folder? })` moves it with `UID MOVE` ([RFC 6851](https://www.rfc-editor.org/rfc/rfc6851)) where the server offers MOVE, else with `UID COPY`, the `\Deleted` flag and `UID EXPUNGE`; the original is touched only once the copy is made.
- `addLabel(uid, label, { folder? })` labels it through Gmail's `X-GM-LABELS` where the server offers X-GM-EXT-1, else copies it into the folder named `label`; the message stays where it is.
- `setFlags(uid, flags, { folder? })` replaces its flags with `flags`, such as `['\\Seen', '$Handled']`, with `UID STORE ... FLAGS`; an empty list clears them. A keyword goes in the spelling the folder's PERMANENTFLAGS give it, matched ignoring case, as IMAP reads a flag's name.
- `deleteMessage(uid, { folder? })` sets the `\Deleted` flag and expunges that UID alone with `UID EXPUNGE` ([RFC 4315](https://www.rfc-editor.org/rfc/rfc4315)), which leaves every other message marked deleted where it is.

A `UID STORE`, `UID COPY` or `UID MOVE` of a UID no message has succeeds having done nothing ([RFC 3501 section 6.4.8](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.8), which [RFC 6851 section 3.2](https://www.rfc-editor.org/rfc/rfc6851#section-3.2) extends to `UID MOVE`), so each change first searches for the UID, and after a store, a label or a copy whose answer cannot tell that it acted on the message, searches again. A change rejects with `EmailMailboxError`, whose `code` says why and whose message holds no UID, folder or address:

- `gone`: the folder holds no message with that UID, which comes before any other answer; or another session expunged it between the search and the change, as the COPYUID a server with UIDPLUS sends ([RFC 4315](https://www.rfc-editor.org/rfc/rfc4315#section-3)), or the search after the change, tells. A caller that wants the message gone, as after a delete that ran before a crash, counts it as done. A `UID MOVE` that another session's expunge overtakes, on a server that sends no COPYUID, resolves as done, the server having answered OK.
- `unsupported`, before anything changes: `deleteMessage` on a server without UIDPLUS, and `moveTo` on one with neither MOVE nor UIDPLUS, where `EXPUNGE` would remove every message marked deleted.
- `refused`: the server refused a command, as it does a destination or a label folder that does not exist, or would not open `folder`; imapflow's own error for that carries the server's text and the command, which name the folder, and the change's error carries neither. `setFlags` also refuses, before anything is stored, a flag the folder's PERMANENTFLAGS do not keep in any spelling, since imapflow would leave it out and a set left with no flag clears every flag.

A `uid` that is not a whole number from 1 to 4,294,967,295, a folder, destination or label that is empty or holds a control character, flags that are not a list of flag names, and `\Recent`, which the server alone sets, throw an `Error` before connecting.

## In an agent

`createExtensionPack(context)` returns five tools, `emailSend`, `emailRead`, `emailSearch`, `emailExtractCodes` and `emailReply`, and the messaging channel `emailChannel`. Its options (`smtpHost`, `smtpUser`, `smtpPassword`, `smtpPort`, `smtpSecure`, `imapHost`, `imapUser`, `imapPassword`, `imapPort`, `imapSecure`, `authServId`, `resendApiKey`, `resendBaseUrl`, `from`, `unsubscribe`) take precedence over the secrets and the environment variables named above; `authServId` falls back to the secret `email.authServId`, then to `EMAIL_AUTH_SERV_ID`, and an empty value at any of them counts as none given, so the next one counts. `manifest.json` lists the SMTP secrets as required, and the IMAP secrets, `email.authServId` and `email.resendApiKey` as optional.

A model names the tools' arguments and the channel's blocks, so `emailSend` and `emailChannel` pass on an attachment only as `content`, a `data:` address or, through Resend, an `http` or `https` address. They refuse any other before anything is sent, reading no file and fetching no address: the tool answers `{ success: false, error }`, the adapter throws an `Error`, and the message names the attachment's filename, never its path.

They send each attachment as they checked it: a copy of its own `filename`, `content`, `path` and `contentType`, each read once, with a Buffer's bytes copied. They refuse the same way an attachment that is not an object, one that gives any of those four through a getter or a setter, and one whose `filename` or `contentType` is not a string. Any other property of an attachment is left out.

The subject, the bodies and the message id a reply names must be text. Through SMTP, nodemailer reads the file or fetches the address an object body names into the message, and writes an object subject or message id marked `prepared` into the headers as it is. So `sendEmail` and `replyToEmail`, whoever calls them, throw a `TypeError` that names the field, never its value, before anything is sent on either transport: `subject`, `body` and the reply's `messageId` must be strings, and `html` a string when given (`null` leaves the HTML part out). `emailSend` and `emailReply` answer it as `{ success: false, error }`, and the adapter throws it. A reply whose message id is not one message id, or names no message in INBOX, is answered and thrown the same way, with the `Error` [reading mail](#reading-mail) describes.

`emailRead`, `emailSearch` and `emailExtractCodes` answer a `limit`, a `since` or a `pattern` that [reading mail](#reading-mail) refuses as `{ success: false, error }`, before any mail is read, and a pattern that runs past its 250 ms the same way; `emailRead` answers a `folder` that is not a name the same way. `emailSearch` gives the last 20 messages it finds. `emailRead` and `emailSearch` answer plain data a model reads: each message without `html` and `text`, its text once as `body`, and each attachment's `name`, `type` and `bytes` without its `read()`. They read under the service's `authServId` and give each message's `authentication` only when the service names one: a model cannot name the host that takes mail into the mailbox, and a read that names no authserv-id counts the topmost Authentication-Results field whatever host it names, which on a host that writes no field of its own is one the sender wrote. An `authServId` in the configuration that is not text, holds a control character or is white space alone throws an `Error` when the pack is made.

## API

| Export | What it is |
|---|---|
| `createExtensionPack(context)` | The pack's factory: the five tools and the channel adapter |
| `EmailService` | Sends through SMTP or Resend's HTTPS API; reads, searches, extracts codes, replies, moves, labels, flags and deletes through IMAP |
| `EmailMailboxError` | A change by UID, or an attachment's read, that failed, with its `code`: `gone`, `refused`, `unsupported` or `too_large` |
| `readHeaderFields(headerBlock, options?)`, `parseAuthenticationResults(headerBlock, options?)` | The fields a header block gives a read, and its Authentication-Results alone |
| `ResendTransport` | Resend's send call, which `EmailService` uses when its configuration names `resend` |
| `EmailApiError`, `retryWaitSeconds` | A refusal from Resend, and the wait before its retry (`null` for none) |
| `requireIdempotencyKey(key)`, `LONGEST_IDEMPOTENCY_KEY` | The key a send carries as Resend takes it (`undefined` for none), or an `Error` for one it cannot take; and 256, its longest |
| `EmailChannelAdapter` | The messaging-channel adapter |
| `EmailSendTool`, `EmailReadTool`, `EmailSearchTool`, `EmailExtractCodesTool`, `EmailReplyTool` | The five tools |
| `SqlSuppressionStore`, `suppressionStoreDdl(prefix)` | The suppression record on a SQL database, and its table's DDL |
| `SqlRecipientCapability`, `recipientCapabilityDdl(prefix)` | Recipient capabilities on a SQL database, and their table's DDL |
| `emailPreferencesDdl(prefix)` | Both tables' DDL |
| `DEFAULT_SUPPRESSION_SCOPE`, `SUPPRESSION_REASONS` | The scope of a host that keeps one list (`mail`), and the reasons an address is suppressed, frozen |
| `createUnsubscribeHandler(options)` | The route an unsubscribe link opens: a GET asks, a POST suppresses |
| `EmailSuppressedError` | A send the suppression record stopped, with `code` `suppressed` and the list in `scope` |
| `DO_NOT_CONTACT_SCOPE`, `OPTIONAL_MAIL_SCOPE`, `categoryScope(category)` | The do-not-contact list, the list of all optional mail, and a category's list |
| `UNSUBSCRIBE_URL_MARKER` | `{{unsubscribe_url}}`, where a part places its link itself |
| `EmailConfig`, `SendEmailOptions`, `EmailMessage`, `EmailAttachment`, `SearchEmailOptions`, `ReadOptions`, `ReadInboxOptions`, `MailboxOptions`, `EmailMailboxErrorCode`, `EmailAuthentication`, `HeaderFieldOptions`, `HeaderFields`, `ResendOptions`, `OutgoingEmail`, `OutgoingAttachment`, `EmailChannelOptions`, `ExtensionContext`, `ExtensionPack`, `UnsubscribeOptions`, `UnsubscribeHandlerOptions`, `UnsubscribeView` | The types of the configuration, the messages, the options and the pack |
| `SuppressionStore`, `SuppressionReason`, `RecipientCapability`, `RecipientGrant`, `RecipientCapabilityIssueOptions`, `SqlRecipientCapabilityOptions`, `EmailPreferencesDb` | The stores' interfaces, their answers and options, and what they need of a database |

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
