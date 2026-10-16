---
"@framers/agentos-ext-channel-email": patch
---

The preference stores refuse the table prefix `sqlite`, and any prefix beginning `sqlite_`, with the `RangeError` any other refused prefix gets, from `suppressionStoreDdl`, `recipientCapabilityDdl`, `emailPreferencesDdl` and both constructors. Their tables would begin `sqlite_`, names SQLite keeps for its own tables and refuses to create, so the DDL failed on SQLite while it ran on PostgreSQL. A host that made its tables under such a prefix on PostgreSQL renames them (`ALTER TABLE sqlite_suppressions RENAME TO mail_suppressions`, the same for `sqlite_capabilities`, and `ALTER INDEX` for `sqlite_capabilities_recipient`) and passes the new prefix.

`SUPPRESSION_REASONS` is frozen, since `suppress` checks a reason against it: pushing to it widened what `suppress` recorded, and emptying it made every `suppress` throw.

`suppress` takes every calendar date written `YYYY-MM-DD`. Its check built the date with `Date.UTC`, which reads the years 0 to 99 as 1900 to 1999, so it refused `0000-01-01` to `0099-12-31` while it passed `0100-01-01`.

`revoke` answers a whole number of 0 or more whatever the handle's `run` gives. It answered `changes` as given, so a handle whose `run` gave text, NaN, -1 or an object (the storage adapter's Capacitor handle before 0.6.14) made it resolve that value. `suppress` and `issue` read `changes` the same way: anything but such a count is no count.

The README states what the stores leave to the host. A plain SHA-256 of an address lets anyone who holds the table check an address they guess, so a host that wants more passes HMAC-SHA256 under a key of its own; the store takes any 64 lower-case hexadecimal characters. Two hosts that share a key draw the same token from the same nonce, whatever their prefixes, so each takes a key of its own or nonces no other host uses. The DDL runs from one process at a time, since PostgreSQL does not promise that two `CREATE TABLE IF NOT EXISTS` of one new table at once both succeed. A name's limit of 512 is JavaScript's `length`, in UTF-16 code units.

0.4.1 was the first release to carry the stores: the 0.4.0 this changelog names was never published.
