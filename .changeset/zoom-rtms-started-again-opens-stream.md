---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The media worker opens the stream when Zoom's started event is handed over again after a write of its first handing over failed. A write that fails there (the run's state or the delivery's receipt, on a full disk or a refused rename) answers the delivery 500, and the provider hands it over again. That second handing over found the run by its stream, asked a stream that was never opened to reconnect and answered 200: no stream opened, the start wait then ended the run as not allowed, and when the failed write was the first to name the stream, your events route never received the started event. The worker now queues your events route's copy of the event before the run's first write that names the stream, and the handing over that follows a failed write opens the stream without sending the copy again.
