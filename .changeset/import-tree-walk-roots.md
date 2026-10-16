---
"@framers/agentos-ext-document-export": patch
---

`walkImportTree` checks every root id before it visits any root, so a repeated or malformed id is refused as `invalid_roots` before any provider is asked for an entry. An error a directory's provider throws while listing is reduced to `enumeration_failed` whatever its class, so an adapter's own `ImportLimitError` or `ImportPathError` is not reported as a run limit or an unsafe path.
