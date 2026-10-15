---
"@framers/agentos-ext-account-sources": minor
---

Answer a request that cannot start within a second of its reservation as `{ kind: 'late', retryAt }`, retryable with a new attempt id, instead of `duplicate`, which stays the answer for a reused attempt id. `SourceQuota.compact()` now answers how many attempt records, mailbox waits, meter reservations and minute-budget rows it deleted, and whether a table has more to delete.
