---
'@framers/agentos-ext-channel-email': patch
---

`SqlRecipientCapability.revoke` keeps each revoked token's row, marked with the time of the revoke, so `issue` refuses a revoked token's nonce for every recipient, scope and expiry: a revoked link never works again and never comes to name another recipient or scope. A message that needs a working token after a revoke takes a new nonce. `revoke` answers how many live tokens it ended, and marks its rows even when the store's clock answers no number.

The capabilities table gains the column `revoked_at BIGINT`. A table made by the earlier `recipientCapabilityDdl` takes it with `ALTER TABLE <prefix>_capabilities ADD COLUMN revoked_at BIGINT`.
