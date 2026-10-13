---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

`ZoomRtmsProvider.usage` answers every run the media worker lists when the closure of one `ending` run cannot be proved yet: that run stays alive in the answer, its closure is tried again on the next pass, and the provider writes one warning with the run's id through its logger, which `createExtensionPack` takes from `context.logger`. A closure that cannot finish holds back no other run, so the manager's reconciliation and dispatch recovery read every run of the provider.
