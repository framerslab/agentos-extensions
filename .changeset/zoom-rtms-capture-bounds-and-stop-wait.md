---
'@framers/agentos-ext-meeting-zoom-rtms': minor
---

`ZoomRtmsProvider.handleWebhook` refuses a body of more than `ZOOM_WEBHOOK_MAX_BYTES` (1 MiB, exported) with 413 and a warning line before it verifies, reads or keeps it, where it took a body of any size.

The capture tool's webhook refuses with 401 `expired delivery` a delivery whose signing time or event time is more than 90 minutes old or more than a minute ahead, as the provider and the media worker do, and answers 400 to a signed body it cannot read, where it acted on any delivery that carried a good signature and answered 500 to one it could not read.

The capture tool reads no more than 1 MiB of a webhook and `CAPTURE_CONTROL_MAX_BYTES` (16 KiB) of an operator call and refuses a larger body with 413 and a `body_too_large` line, where it read every body whole; its process writes each line as one JSON object with its level.

The capture tool writes a recording once Zoom's `meeting.rtms_stopped` for the stream has come, waiting up to `STOPPED_WEBHOOK_WAIT_MS` (5 s) after Zoom closes the stream's signaling connection, where it wrote the record a second after the close and kept a stop that came later out of the fixture.

The capture tool keeps a stream's media frames while their bytes stay within `CAPTURE_MEDIA_MAX_BYTES` (8 MiB), drops the frames after them with one `media_capped` line and counts them in the summary as `mediaDropped`, where it kept every frame.
