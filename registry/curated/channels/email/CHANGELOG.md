# @framers/agentos-ext-channel-email

## 0.4.4

### Patch Changes

- [#301](https://github.com/framerslab/agentos-extensions/pull/301) [`f514347`](https://github.com/framerslab/agentos-extensions/commit/f5143470653e51e1cb5038c7b832aafa57887443) Thanks [@jddunn](https://github.com/jddunn)! - `SqlRecipientCapability.issue` takes a key made in another realm, such as a `vm` context or a test runner's sandbox, as the same bytes made here. Its check was `instanceof Uint8Array`, which is false for such a key, so a key of 32 bytes was refused with a `TypeError`; the check now reads the value with `util.types.isUint8Array`. The rule is otherwise unchanged: a `Uint8Array` or a `Buffer` of 32 bytes or more.

- [#297](https://github.com/framerslab/agentos-extensions/pull/297) [`5957b4b`](https://github.com/framerslab/agentos-extensions/commit/5957b4b766efe138b79e50838b0679ea7033d496) Thanks [@jddunn](https://github.com/jddunn)! - The preference stores take every table prefix 0.4.2 took again: a lower-case letter followed by at most 39 lower-case letters, digits or underscores, `sqlite` and the prefixes beginning `sqlite_` among them. 0.4.3 refused those with a `RangeError` from `suppressionStoreDdl`, `recipientCapabilityDdl`, `emailPreferencesDdl` and both constructors, so a PostgreSQL host whose tables were made under such a prefix failed at start on a patch release. That host keeps its tables and its prefix, and the rename 0.4.3's notes gave is not needed; a host that made the rename keeps its new prefix.
  
  On SQLite such a prefix makes table names SQLite keeps for its own tables, and SQLite's `CREATE TABLE` refuses them, so the DDL fails there with SQLite's own error, and so does every call of a store on that prefix: a host on SQLite takes another prefix.

## 0.4.3

### Patch Changes

- [#276](https://github.com/framerslab/agentos-extensions/pull/276) [`8ea2970`](https://github.com/framerslab/agentos-extensions/commit/8ea2970529d1ad7ab17fe1cdecbd932d0f2c5519) Thanks [@jddunn](https://github.com/jddunn)! - The preference stores refuse the table prefix `sqlite`, and any prefix beginning `sqlite_`, with the `RangeError` any other refused prefix gets, from `suppressionStoreDdl`, `recipientCapabilityDdl`, `emailPreferencesDdl` and both constructors. Their tables would begin `sqlite_`, names SQLite keeps for its own tables and refuses to create, so the DDL failed on SQLite while it ran on PostgreSQL. A host that made its tables under such a prefix on PostgreSQL renames them (`ALTER TABLE sqlite_suppressions RENAME TO mail_suppressions`, the same for `sqlite_capabilities`, and `ALTER INDEX` for `sqlite_capabilities_recipient`) and passes the new prefix.
  
  `SUPPRESSION_REASONS` is frozen, since `suppress` checks a reason against it: pushing to it widened what `suppress` recorded, and emptying it made every `suppress` throw.
  
  `suppress` takes every calendar date written `YYYY-MM-DD`. Its check built the date with `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999, so it refused `0000-01-01` to `0099-12-31` while it passed `0100-01-01`.
  
  `revoke` answers a whole number of 0 or more whatever the handle's `run` gives. It answered `changes` as given, so a handle whose `run` gave text, NaN, -1 or an object (the storage adapter's Capacitor handle before 0.6.14) made it resolve that value. `suppress` and `issue` read `changes` the same way: anything but such a count is no count.
  
  The README states what the stores leave to the host. A plain SHA-256 of an address lets anyone who holds the table check an address they guess, so a host that wants more passes HMAC-SHA256 under a key of its own; the store takes any 64 lower-case hexadecimal characters. Two hosts that share a key draw the same token from the same nonce, whatever their prefixes, so each takes a key of its own or nonces no other host uses. The DDL runs from one process at a time, since PostgreSQL does not promise that two `CREATE TABLE IF NOT EXISTS` of one new table at once both succeed. A name's limit of 512 is JavaScript's `length`, in UTF-16 code units.
  
  0.4.1 was the first release to carry the stores: the 0.4.0 this changelog names was never published.

- [#275](https://github.com/framerslab/agentos-extensions/pull/275) [`4faf147`](https://github.com/framerslab/agentos-extensions/commit/4faf14730fbb0db2b43e9226718360097dfbf279) Thanks [@jddunn](https://github.com/jddunn)! - Check what the IMAP reads are given before any mail is read, and bound the work done over each message.
  
  - `readInbox` and `searchEmails` refuse a `limit` that is not a whole number of at least 1. `readInbox` fetched a sequence number past the last message for one, which a server answers BAD, and `searchEmails` gave every match or the wrong ones.
  - `searchEmails` takes `since` as an ISO 8601 date, such as `2026-10-15`, alone or followed by a time and an offset, and searches from the day it names, as written, on every server. It refuses anything else before the search: text `Date` cannot read, which imapflow left out of the search, so mail of every date came back; a number, which was read as milliseconds after 1970; text in another form, which `Date` read by guesswork in the local time zone; and a day its month lacks, such as `2026-02-30`, which was read as 2 March. imapflow was given a `Date`, which it sends to a server that announces WITHIN as the seconds since that moment and to any other as its day in UTC, so one search found different mail on different servers.- `readInbox` and `searchEmails` read a message whose Date field does not read as a date with an empty `date`, where they threw for every message of the folder.
  - `extractCodes` refuses a `pattern` that is not a string, or does not compile, before any mail is read; moves on past a match of empty text, where it looped for ever; gives no empty code; and stops a pattern that runs longer than 250 ms over the message, such as `(\d+)+$` over a long run of digits.
  - `extractCodes` finds the HTML part's tags in one pass, where a run of `<` with no `>` after it took time growing with its square.

## 0.4.2

### Patch Changes

- [#266](https://github.com/framerslab/agentos-extensions/pull/266) [`2a345d0`](https://github.com/framerslab/agentos-extensions/commit/2a345d03c5fdc37b6dce6e0b1b09452f40373f3e) Thanks [@jddunn](https://github.com/jddunn)! - Header fields go out alike through both transports. `sendEmail`'s `headers` and `ResendTransport.send`'s `headers` now refuse, before anything is sent, what nodemailer and Resend's API would carry differently: an empty or blank value (nodemailer left the field out, Resend sent it empty), a character outside US-ASCII (nodemailer wrote the whole value as an RFC 2047 encoded word), white space at either end or two white-space characters in a row (nodemailer could fold them into a line of white space alone), a word so long that the name, a colon, a space and the word pass RFC 5322's 998 characters a line, and an `In-Reply-To` or `References` that is not a list of message ids in angle brackets. Through SMTP each field is now written as given, folded at its white space, so a value with a double quote arrives as written rather than encoded. A plain object of fields made in another realm, such as a `vm` context, is accepted. A line break or other control character in a subject is sent as a space through both transports.
  
  `searchEmails`, `extractCodes` and `replyToEmail` fetch the messages a search finds by their UIDs; they fetched those numbers as sequence numbers, which read other messages, or none, wherever UIDs do not follow sequence numbers. `extractCodes` and `replyToEmail` take only the message whose own Message-ID is the one given, with or without its angle brackets, where an IMAP search matches every Message-ID that holds the text.
  
  `replyToEmail` reads the original's `References` field of that very name, whole however it is folded, and falls back to its `In-Reply-To` when that names one id, as RFC 5322 section 3.6.4 has it; it read `X-References` first, kept only the first line of a folded field, and took the next field when the field was empty. An id there that holds a control character is left out, where a reply through Resend threw. The reply names the original in angle brackets through both transports, goes to its Reply-To when it names one, and keeps one `Re:` whatever its case. A message id that is not one id, or that no message in INBOX has, and an original with no address to reply to, now throw an `Error` before anything is sent: such a reply went out to an empty address.

- [#261](https://github.com/framerslab/agentos-extensions/pull/261) [`3904fe7`](https://github.com/framerslab/agentos-extensions/commit/3904fe7aa4c664687871757d6dbfee2c568b63f0) Thanks [@jddunn](https://github.com/jddunn)! - `SqlSuppressionStore` and `SqlRecipientCapability` refuse a scope, a recipient or a nonce that holds U+0000 or a lone surrogate, with a `TypeError` that names the argument and none of its value, before any statement. PostgreSQL's text refuses U+0000, and UTF-8 cannot encode a lone surrogate, so node-postgres wrote U+FFFD in its place: on PostgreSQL a `revoke` given one could end another recipient's tokens, and `find` could answer a recipient other than the one the token was issued for. A name with characters past U+FFFF is kept as given.

## 0.4.1

### Patch Changes

- [#257](https://github.com/framerslab/agentos-extensions/pull/257) [`03533c9`](https://github.com/framerslab/agentos-extensions/commit/03533c99746a52d097727fd0f02626446a75f0ad) Thanks [@jddunn](https://github.com/jddunn)! - `SqlRecipientCapability.revoke` keeps each revoked token's row, marked with the time of the revoke, so `issue` refuses a revoked token's nonce for every recipient, scope and expiry: a revoked link never works again and never comes to name another recipient or scope. A message that needs a working token after a revoke takes a new nonce. `revoke` answers how many live tokens it ended, and marks its rows even when the store's clock answers no number. A row refuses its nonce for as long as it stays, so a host that deletes rows, by a foreign key's `ON DELETE CASCADE` or by hand, never issues their nonces again.
  
  The capabilities table gains the column `revoked_at BIGINT`. A table made by the earlier `recipientCapabilityDdl` takes it with `ALTER TABLE <prefix>_capabilities ADD COLUMN revoked_at BIGINT`.

## 0.4.0

### Minor Changes

- [#250](https://github.com/framerslab/agentos-extensions/pull/250) [`8e3ca47`](https://github.com/framerslab/agentos-extensions/commit/8e3ca47b6a550c5afe99e6a38b6640f5f735b042) Thanks [@jddunn](https://github.com/jddunn)! - Add a suppression record and recipient capabilities, the stores a sender reads before a send, each on a host's SQL database: `@framers/sql-storage-adapter`'s adapter on SQLite or PostgreSQL, or any handle with its `run` and `get`. The pack gains no runtime dependency.
  
  `SqlSuppressionStore` records an address in a scope by its SHA-256, which the host computes, with the reason (`bounce`, `complaint`, `suppressed` or `manual`) and the day, and answers `isSuppressed` for one scope. A second record of an address in a scope writes nothing and keeps the first, so a provider's repeated event is harmless. A hash that is not 64 lower-case hexadecimal characters, an address among them, is refused with a `TypeError` that holds none of it. `DEFAULT_SUPPRESSION_SCOPE` (`mail`) is the scope of a host that keeps one list.
  
  `SqlRecipientCapability` issues an opaque token for a recipient and a scope, base64url of HMAC-SHA256 over the caller's nonce under the caller's key of 32 bytes or more, and stores only the token's SHA-256. `find` answers the recipient and the scope, or `null` for a malformed, unknown, revoked or expired token, comparing in constant time. `revoke` ends every token of a recipient. The same nonce under the same key gives the same token, so a retried message carries the token it first carried; issuing a nonce for another recipient or scope throws.
  
  `suppressionStoreDdl(prefix)`, `recipientCapabilityDdl(prefix)` and `emailPreferencesDdl(prefix)` give the tables' DDL under a table prefix, for SQLite and PostgreSQL.

## 0.3.0

### Minor Changes

- [#241](https://github.com/framerslab/agentos-extensions/pull/241) [`b1576a9`](https://github.com/framerslab/agentos-extensions/commit/b1576a9056c5861fcfc5ade8b989b0754d0c0b17) Thanks [@jddunn](https://github.com/jddunn)! - `sendEmail` takes `headers`, header fields to add to the message by name, such as `List-Unsubscribe` and `List-Unsubscribe-Post` for a one-click unsubscribe (RFC 8058). Through Resend they go in the request's `headers`; through SMTP nodemailer writes each into the message. `headers` is a plain object: a name must be printable US-ASCII with no space or colon, the field name of RFC 5322, and a value a string with no line break or other control character than the tab, so no field given can end and start another. An object value, such as one marked `prepared`, which nodemailer writes into the message as it is, is refused.
  
  The fields never replace the service's own. `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and any `Content-` field are refused in any case, where nodemailer would have kept one of the two values without a word, and a name given twice in different cases is refused too. Each refusal throws an `Error` before either transport is used, naming the field, or its place when its name is at fault, and none of its value. Each value is read once and the fields are sent as read; nodemailer gets them as a list, so an object with `key` and `value` properties adds two fields of those names. A send without `headers` is unchanged.
  
  `ResendTransport.send` checks a message's `headers` by the same rules for names and values before any request. A reply through Resend whose message id holds a line break now throws that `Error` instead of sending the id in `In-Reply-To` and `References`.

## 0.2.1

### Patch Changes

- [#127](https://github.com/framerslab/agentos-extensions/pull/127) [`c23b246`](https://github.com/framerslab/agentos-extensions/commit/c23b24657d5e45eb321d90ef453de592221c85b2) Thanks [@jddunn](https://github.com/jddunn)! - `sendEmail` and `replyToEmail` refuse a subject, a body or a reply's message id that is not a string, and an HTML body that is given and is not one, with a `TypeError` that names the field and none of its value, before anything is sent on either transport. Through SMTP, nodemailer read the file or fetched the address that an object given as a body names into the message, and wrote an object subject or message id marked `prepared` into the headers as it is; a model's tool arguments and the channel's blocks are JSON, so they could carry such an object whatever the types said. The `emailSend` and `emailReply` tools answer the refusal as `{ success: false, error }` and the channel adapter throws it. An HTML body of `null` sends no HTML part, as `undefined` does. Code that passed an object, a Buffer or a stream as a body or a subject passes a string.
  
  The `emailSend` tool and the channel adapter send the attachments as their check read them: a copy of each attachment's own `filename`, `content`, `path` and `contentType`, each read once, with a Buffer's bytes copied. A path given by a getter could answer the check with a `data:` address and the send with a file, and a Buffer carrying its own `path` property had nodemailer read that file. They now refuse an attachment that is not an object, one that gives any of those four through a getter or a setter, and one whose `filename` or `contentType` is not a string, and they leave out any other property.

## 0.2.0

### Minor Changes

- [#111](https://github.com/framerslab/agentos-extensions/pull/111) [`d4c78ff`](https://github.com/framerslab/agentos-extensions/commit/d4c78ffbcab1b73542983b826e038ca9607c2ef8) Thanks [@jddunn](https://github.com/jddunn)! - Send through Resend's HTTPS API as well as SMTP: a `resend` transport with an idempotency key, the text and HTML parts in one call, Resend's error shape (`EmailApiError` with the status and the error's name) and its retry terms inside one deadline. A `from` with a display name for both transports. nodemailer 10 for SMTP. nodemailer 9.0.0 and later check TLS certificates when they fetch remote content, so an attachment given as an https `path` to a host with a self-signed, expired or mismatched certificate now fails. nodemailer 8.0.0 renamed the error code `NoAuth` to `ENOAUTH`. The `@framers/agentos` peer is now optional, since the pack imports nothing from it. The `emailSend` tool and the channel adapter no longer read files on this machine, and through SMTP no longer fetch addresses, for attachments a model names: they refuse such an attachment before sending.

## 0.1.2

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
