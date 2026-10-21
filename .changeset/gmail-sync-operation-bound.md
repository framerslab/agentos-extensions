---
'@framers/agentos-ext-gmail-source': patch
---

`runGmailSourceSync` gives the coordinator `operationTimeoutMs` 90,000 when the host's coordinator options name none,
the connector's own bound on one operation. A run that resumes queued reads starts on a fresh connector, so its first
read refreshes the grant, then reads the profile, the labels and the thread, each under a deadline of its own: four
eight-second requests took 32 seconds, past the coordinator's 30-second default, which cut the read as a `network`
failure, and every retry built another connector and repeated the sequence, so under that latency the thread was never
read and the cycle never committed. A host's own value still applies. It needs the account-sources release that accepts
an `operationTimeoutMs` of 90,000.
