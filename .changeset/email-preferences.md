---
'@framers/agentos-ext-channel-email': minor
---

Add a suppression record and recipient capabilities, the stores a sender reads before a send, each on a host's SQL database: `@framers/sql-storage-adapter`'s adapter on SQLite or PostgreSQL, or any handle with its `run` and `get`. The pack gains no runtime dependency.

`SqlSuppressionStore` records an address in a scope by its SHA-256, which the host computes, with the reason (`bounce`, `complaint`, `suppressed` or `manual`) and the day, and answers `isSuppressed` for one scope. A second record of an address in a scope writes nothing and keeps the first, so a provider's repeated event is harmless. A hash that is not 64 lower-case hexadecimal characters, an address among them, is refused with a `TypeError` that holds none of it. `DEFAULT_SUPPRESSION_SCOPE` (`mail`) is the scope of a host that keeps one list.

`SqlRecipientCapability` issues an opaque token for a recipient and a scope, base64url of HMAC-SHA256 over the caller's nonce under the caller's key of 32 bytes or more, and stores only the token's SHA-256. `find` answers the recipient and the scope, or `null` for a malformed, unknown, revoked or expired token, comparing in constant time. `revoke` ends every token of a recipient. The same nonce under the same key gives the same token, so a retried message carries the token it first carried; issuing a nonce for another recipient or scope throws.

`suppressionStoreDdl(prefix)`, `recipientCapabilityDdl(prefix)` and `emailPreferencesDdl(prefix)` give the tables' DDL under a table prefix, for SQLite and PostgreSQL.
