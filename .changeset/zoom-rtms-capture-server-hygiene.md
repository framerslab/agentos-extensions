---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The capture tool reads a request body that is past its limit to its end before it answers 413, so the answer reaches the sender in place of a reset, where it answered as soon as the limit was passed.

A recording keeps a `meeting.rtms_stopped` or `meeting.rtms_interrupted` of another stream out of its record and notes it for the operator as `foreignWebhook`, where it kept any stop that came while it recorded.

The capture tool arms no further wait once its record is written, where its own close of the connection armed a five-second wait again.

An operator call whose body cannot be read as JSON is answered 400 `unreadable`, and an empty or blank body means no settings, where an unreadable body was answered 500.
