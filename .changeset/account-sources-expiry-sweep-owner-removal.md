---
"@framers/agentos-ext-account-sources": minor
---

Sweep expired copies from every connection and remove a deleted owner's rows. `SqlAccountSourceSyncStore.sweepExpired(limit, owner?)` removes retained sources whose expiry has passed from every connection, or one owner's, the earliest first, and `AccountSourceSync.maintain` runs it at the start of each pass, so an expired copy no longer waits for the maintenance walk to reach its connection. `SourceRevocations.removeOwner(owner)` removes a deleted owner's rows in one transaction once its purge, its revocations and its exchanges are over: its connections with their work, provenance and exclusions (through the new `SqlAccountSourceSyncStore.removeOwner`), its stop intents, the queue rows they refer to, its grant leases, its exchanges and its block marker. `removeDeletedOwners(limit)` removes every such owner, and each removal emits the lifecycle event `removed`. The core fence's owner row and its deletion records stay.
