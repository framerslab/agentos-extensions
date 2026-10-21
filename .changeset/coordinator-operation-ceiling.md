---
'@framers/agentos-ext-account-sources': patch
---

`AccountSourceSync` accepts an `operationTimeoutMs` up to 90,000, the run budget's ceiling, where it refused a value over
60,000 with `invalid_source_coordinator_policy`; the default stays 30,000. A provider whose one call makes several
requests in sequence, each under its own deadline, needs their sum, as a Gmail read on a fresh connector does: it
refreshes the grant, then reads the profile, the labels and the thread, and the Gmail connector bounds one operation at
90 seconds itself.
