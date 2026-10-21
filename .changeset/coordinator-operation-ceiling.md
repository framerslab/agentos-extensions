---
'@framers/agentos-ext-account-sources': patch
---

`AccountSourceSync` accepts an `operationTimeoutMs` up to 90,000 and a `runBudgetMs` up to 180,000, where it refused
values over 60,000 and 90,000 with `invalid_source_coordinator_policy`; the defaults stay 30,000 and 90,000. A provider
whose one call makes several requests in sequence, each under its own deadline, needs their sum, as a Gmail read on a
fresh connector does: it refreshes the grant, then reads the profile, the labels and the thread, and the Gmail connector
bounds one operation at 90 seconds itself. The run budget counts from the start of the run and cuts each call at its
end, so a read and its preparation have to fit it together, and the new ceiling holds one of each at the operation
ceiling.
