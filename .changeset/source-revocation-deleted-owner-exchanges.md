---
"@framers/agentos-ext-account-sources": patch
---

Remove a deleted owner's authorization exchanges recorded unconfirmed, and those whose returned grant's revocation expired or could not be opened, in `SourceRevocations.compact()` a day after their end, with their queue rows a day after the rows' own deadline, instead of keeping them for an acknowledgement a deleted owner can never give.
