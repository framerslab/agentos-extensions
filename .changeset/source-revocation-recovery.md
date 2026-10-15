---
"@framers/agentos-ext-account-sources": minor
---

Fence source purge and credential transfer, serialize grant refresh across workers, and recover bounded revoke-only attempts independently of account lifetime. Record authorization exchanges before their requests are sent, so a returned grant that is not installed is revoked through the same queue, and an outcome that cannot be confirmed keeps new grants blocked until the account owner acknowledges removing the permission.
