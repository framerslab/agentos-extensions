---
"@framers/agentos-ext-account-sources": patch
---

Charge a source's indexing once. `applyResult` applies a read at the version, content hash and message spans of the copy the store already holds with no indexing charge and no indexing-limit check, so a reconcile that reads every retained source again no longer spends the month's allowance and then deletes copies as `indexing_limit`. With the new optional `refresh` binding the copy stays in place, with the results derived from it, and takes the read's expiry and message windows; without the binding it is written again from a fresh preparation. An `indexing_limit` skip keeps a retained copy that the changed read still holds whole, every message at the same span, instead of deleting it. `AccountSourceSync` applies each read before preparing it and prepares only a document the store has to write (`applyResult` given no prepared value answers `pending` for one), so a skipped read, or one the store already holds, is never embedded.
