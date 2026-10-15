---
"@framers/agentos-ext-gmail-source": minor
---

Add a bounded selected-id Gmail connector and durable-sync binding with private mailbox verification, expiring label snapshots and explicit connector disposal. The API clients of one sync lease can share one access token through `tokenHolder`, so a cycle refreshes the grant once.
