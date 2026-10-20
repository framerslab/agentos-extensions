---
'@framers/agentos-ext-account-sources': patch
---

A quota attempt's one-second send window opens at a second reading of the clock, taken once its three budgets hold the
weight, not at the reading that begins the reservation, so budget statements that take longer than a second on a slow
database no longer leave every call late before it can start. The slot's record, the commit and the start's wait for
the project's lock still come out of that second, since only the start's reading catches a process that stalled after
the commit. A call that is late all the same gives its weight back to the three budgets through the core meters'
refund, since nothing was sent, so a run of late starts spends none of the day's budget. A request a minute budget
refuses is told to come back once enough of the units in that window have left it, a minute and a millisecond after
their reservations, not a minute after the refusal. `AccountSourceSync.maintain` clears old records in the first batch
of each walk: given the new `quota` option, it compacts the quota's day-old attempt records and settled reservations,
again while `compact` answers `more`, ten calls at most; and it calls the lifecycle's `compact` and
`removeDeletedOwners(limit)` when the lifecycle has them, as `SourceRevocations` does, through two new optional members
of `SourceSyncLifecycle`. The maintenance result gains `compacted` and `removedOwners`, and a cleanup that fails counts
in `failed`.
