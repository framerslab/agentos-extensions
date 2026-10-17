---
"@framers/agentos-ext-channel-email": patch
---

The preference stores take every table prefix 0.4.2 took again: a lower-case letter followed by at most 39 lower-case letters, digits or underscores, `sqlite` and the prefixes beginning `sqlite_` among them. 0.4.3 refused those with a `RangeError` from `suppressionStoreDdl`, `recipientCapabilityDdl`, `emailPreferencesDdl` and both constructors, so a PostgreSQL host whose tables were made under such a prefix failed at start on a patch release. That host keeps its tables and its prefix, and the rename 0.4.3's notes gave is not needed; a host that made the rename keeps its new prefix.

On SQLite such a prefix makes table names SQLite keeps for its own tables, and SQLite's `CREATE TABLE` refuses them, so the DDL fails there with SQLite's own error, and so does every call of a store on that prefix: a host on SQLite takes another prefix.
