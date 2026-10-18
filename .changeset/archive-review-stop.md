---
'@framers/agentos-ext-document-export': patch
---

The archive reader settles a worker read as `stopped` when its signal fires or its archive closes after a step is read and before the step reaches the worker, instead of leaving the read unsettled and its archive busy.
