---
'@framers/agentos-ext-gmail-source': patch
---

`runGmailSourceSync` gives the coordinator `operationTimeoutMs` 90,000 and `runBudgetMs` 180,000 when the host's
coordinator options name none. A run that resumes queued reads starts on a fresh connector, so its first read refreshes
the grant, then reads the profile, the labels and the thread, each under a deadline of its own: four eight-second
requests took 32 seconds, past the coordinator's 30-second default for one call, which cut the read as a `network`
failure, and every retry built another connector and repeated the sequence, so under that latency the thread was never
read and the cycle never committed. 90,000 is the connector's own bound on one operation. The run budget counts from the
start of the run and cuts each call at its end, so a 90-second budget left a read of four 14-second requests after a
second of setup 33 seconds for its preparation; 180,000 holds the setup, a read at the connector's bound and its
preparation. A host's own values still apply. It needs the account-sources release that accepts those values.
