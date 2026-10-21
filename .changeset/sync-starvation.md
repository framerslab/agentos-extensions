---
'@framers/agentos-ext-account-sources': patch
---

A read that keeps failing no longer holds its connection, and an outage gives up no read. The coordinator records a
read's retriable failure with its wait. After a `network` or `provider_unavailable` failure with no retry time from the
provider it goes on to the next due read, one that has not failed before one whose wait has passed, so a source that
cannot be read holds back none queued with it; a second failure in a row ends the run. A `rate_limited` failure or a
provider's retry time ends the run until that time, and a failed preparation or store write until the read's wait.

The store counts a read's failures across its counts of attempts (`failures` on `SourceSyncWork`, absent from a row an
earlier release wrote) and from the tenth on records the read as skipped with the new reason `attempt_limit` once the
failures are evidently its own: the provider answered another read of the cycle in the run of the read's first failure
or since, or, for a failed preparation, another document was prepared and written. In an outage nothing is answered, so
no read is given up until its cycle has been open for `reconcileMs`. A given-up read keeps the copy the store holds
within its own expiry and window, the cycle commits its cursor past it, and the source is read again when a change lists
it or a reconcile's scan does. `attempt_limit` is the store's own: a read result that carries it is refused as
`invalid_response`.

`takeWork` takes the first pending item by source id, then the one whose wait passed first, each through one of two new
work indexes that `sourceSyncSchema` creates (run the migration again to add them), and `progress` reads the cycle's
counts from its checkpoint (`tally`, a `SourceSyncTally`), so a cycle of many queued reads costs rows that grow with the
reads rather than with their square. A host sees the same `examined`, `committed` and `skipped` counts.
