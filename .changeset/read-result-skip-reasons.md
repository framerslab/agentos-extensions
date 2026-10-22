---
'@framers/agentos-ext-account-sources': patch
'@framers/agentos-ext-gmail-source': patch
---

A provider's read result can no longer carry `attempt_limit`, the store's own skip reason, which `applyResult` has always refused at run time as `invalid_response`: the skipped reason of `SourceSyncReadResult` is the new `SourceSyncReadSkipReason`, every `SourceSyncSkipReason` but `attempt_limit`, so a provider that returned it fails to compile instead of failing its sync. The Gmail source's mapping fault and its skipped threads take the same narrowed reason (`GmailMappingFault.reason`, written against any account-sources release from 0.9.4, the peer floor). Nothing changes at run time.
