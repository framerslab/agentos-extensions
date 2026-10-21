---
'@framers/agentos-ext-account-sources': patch
---

A document whose cache lifetime ends between its admission and its second application, as one admitted with a few
seconds of it left and prepared for longer, is recorded as an `expired` skip: the cycle commits its cursor and the
connection keeps its next scheduled sync. The store refused such a read as `invalid_response`, the run ended with
`sync_failed`, and that cleared `nextSyncAt`, so the mailbox left the schedule until a manual request or a control put
it back. A host sees the read counted among the cycle's skips, its previous copy removed as after any skip, and the
source read again the next time a cycle lists it: a later history change that names it, or a scan that finds it, such as
a reconcile's. Like a `gone` result or a skip the provider answers, the expired read withdraws a copy the store still
holds in a commit of its own before it purges it, so a host `purge` binding that throws leaves nothing derived from that
copy deliverable, and the next maintenance removes it. In `SourceRevocations.withGrant` and `SourceQuota.run`, a failure
to delete the grant lease or release the attempt's slot behind what `work` or `send` threw no longer replaces what was
thrown: a refused grant reaches the coordinator as `grant_rejected`, which fences the grant through
`lifecycle.loseGrant` and answers `reconnect`, where the host saw `storage_unavailable` and a retry that left the
authorization state unchanged. Behind a result or a completed call a failed cleanup still answers `storage_unavailable`;
the lease and the slot free at their own expiry either way.
