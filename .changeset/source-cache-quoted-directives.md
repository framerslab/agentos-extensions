---
"@framers/agentos-ext-account-sources": patch
---

Accept a comma inside a quoted `Cache-Control` directive value instead of refusing the header as `invalid_cache_header`; a quoted value left open is still refused.
