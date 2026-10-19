---
'@framers/agentos-ext-account-sources': patch
---

A read that keeps failing no longer holds its connection. The coordinator records a read's retriable failure with its
wait and goes on to the next due read, one that has not failed before one whose wait has passed, so a source that
cannot be read holds back neither the reads queued with it nor, after its tenth failure, the cycle's cursor: that
failure records the read as skipped with the new reason `attempt_limit`, the copy the store holds of the source stays
within its own expiry and window, and the source is read again when a change lists it or a reconcile's scan does. The
store counts a read's failures across its counts of attempts (`failures` on `SourceSyncWork`, absent from a row an
earlier release wrote). `takeWork` reads one row a take, a pending item before one whose retry time has come, and
`progress` and `finish` count the work and the retained sources in the database, so a cycle of many queued reads costs
rows that grow with the reads rather than with their square. A host sees the same `examined`, `committed` and `skipped`
counts, the skipped read among them, and a mailbox whose one thread cannot be read goes on syncing the rest.
