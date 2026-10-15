# @framers/agentos-ext-channel-email

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
