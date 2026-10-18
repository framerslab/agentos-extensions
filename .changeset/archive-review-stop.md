---
'@framers/agentos-ext-document-export': patch
---

A worker read of the archive reader whose signal fires, or whose archive closes, after a step is read and before the step reaches the worker is refused as `stopped` instead of waiting forever on the ended worker; a read stopped by its signal lets its archive go, so later reads are not refused as `busy`.
