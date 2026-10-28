---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The media worker's start wait ends only a run whose stream Zoom has not named. It had ended as not allowed (`left` with `permission_denied` and the word `host_did_not_allow`), with the stream closed at Zoom, a run whose started event had matched inside the wait when the handshakes that follow were still out as the wait ran out. The pack's own suite showed it on a loaded runner, where its 300 millisecond wait ran out inside the fake Zoom's handshake and the suite then waited for a stream the worker had closed (CI run 40244692083 of 25 October 2026 and the first attempt of release run 40271806128 of 26 October). A run whose stream Zoom has named now answers to the handshakes' own bounds alone: ten seconds for each handshake, then Zoom's windows for reconnecting, and `crashed` with `stream_lost` or `handshake_refused` when they run out.
