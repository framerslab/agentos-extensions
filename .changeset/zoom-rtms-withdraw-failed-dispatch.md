---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

When Zoom refuses or fails the start of a run the media worker has already accepted, the provider takes the run back with the worker's new `withdraw` command instead of `kill`. The worker closes what the run opened, drops the reports still waiting and posts nothing more of the run, its end included, and it keeps the withdrawal in the run's state file. The manager then tries the dispatch again or ends the run with the refusal's reason and word. Before, the worker's `left` report of the taken-back attempt reached the manager while it still held the attempt's dispatch record, and a fault of the moment at Zoom ended the run as `stopped_by_owner` instead of being tried again.
