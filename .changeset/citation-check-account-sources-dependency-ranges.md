---
'@framers/agentos-ext-citation-check': patch
'@framers/agentos-ext-account-sources': patch
---

citation-check takes `@framers/agentos-ext-grounding-guard` from `^0.9.0` and account-sources takes `@framers/sql-storage-adapter` from `^0.8.3`, the releases the weekly bump pins. grounding-guard 0.9.0 declares the same `@framers/agentos` peer floor as 0.8.1 (`>=0.12.0`), so citation-check's peer range is unchanged.
