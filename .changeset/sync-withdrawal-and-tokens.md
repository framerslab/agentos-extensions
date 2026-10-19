---
'@framers/agentos-ext-account-sources': patch
---

A read that answers `gone`, or a skip the provider answers, withdraws the source's retained copy in a transaction of
its own before the one that removes it: the copy's expiry moves to the store's clock, so `readCurrent` answers it
expired and the fence neither commits nor delivers anything derived from it, even when the removal then fails, as when
the host's purge throws. The next `expire` or `sweepExpired` removes a withdrawn copy, as does the read's retry. A
page token may be up to 4,096 characters, the most Gmail's transport admits, so a token longer than the 1,024
characters ids and cursors keep is checkpointed instead of failing its page as a storage error on every run. A
`SourceSyncExpiryError` names the sources its `expire` removed before failing in `partial.sourceIds`, beside their
count in `partial.removed`.
