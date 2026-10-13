---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The media worker no longer posts again a report the host's events route refuses. The route answers 401 once a run's end is settled there (the manager completes a run on its `left` report, so the `done` that follows is refused), and the worker kept that report at the head of the run's queue for ever: the run never left the worker, its state file stayed, `GET /capacity` never freed its slot and `POST /drain` never reached zero. A refusal, a 4xx answer other than 408 and 429, is now logged with the run's id and the status and taken off the queue. A 408, a 429, a 5xx or a network fault still keeps the report, and every report after it, for the next try.
