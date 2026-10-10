---
'@framers/agentos-ext-public-sources': patch
---

Wikipedia's provider: a served page's own title no longer becomes a block and a passage; a search's start is stamped when it is sent, after the caller's `onSend`, so a search that `onSend` refuses spends none of the limiter's minute and a slow `onSend` never brings two requests closer than 250 ms; after `onSend` has run, a block that came meanwhile, or a spacing that would take the wait past the limiter's `waitMs`, ends the search as `limited` with nothing sent; a phrase or a key no address can carry answers `failed` or `skipped` without a request instead of throwing; the text budget never cuts a character in two.
