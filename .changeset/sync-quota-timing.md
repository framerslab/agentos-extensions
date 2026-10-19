---
'@framers/agentos-ext-account-sources': patch
---

A quota attempt's one-second send window counts from the end of its reservation: `SourceQuota.run` reads the clock
again once the three budgets hold the weight, so reservations that take longer than a second, waiting on the project's
lock among other reasons, no longer leave every call late before it can start. A call that is late all the same gives
its weight back to the three budgets through the core meters' refund, since nothing was sent, so a run of late starts
spends none of the day's budget. A request a minute budget refuses is told to come back once enough of the units in that
window have left it, a minute and a millisecond after their reservations, not a minute after the refusal.
`AccountSourceSync.maintain` clears old records in the first batch of each walk: given the new `quota` option, it
compacts the quota's day-old attempt records and settled reservations, again while `compact` answers `more`, ten calls
at most; and it calls the lifecycle's `compact` and `removeDeletedOwners(limit)` when the lifecycle has them, as
`SourceRevocations` does, through two new optional members of `SourceSyncLifecycle`. The maintenance result gains
`compacted` and `removedOwners`, and a cleanup that fails counts in `failed`.
