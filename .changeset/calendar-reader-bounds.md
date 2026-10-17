---
'@framers/agentos-ext-calendar-google': patch
---

`GoogleCalendarReader` holds each call to its deadline and the caller's signal from the wait for the host's token to the last byte of the answer. A token supplier that stalls answers `timeout` past `deadlineMs` and `cancelled` once the signal aborts, and a token that comes after either is never sent; a `fetchImpl` deaf to its signal, a body that comes late and a body that never ends stop the read the same way, the body's stream cancelled. An error the token supplier throws still passes through as thrown, now documented. `mapCalendarEvent` reads a video entry point whose address does not parse as HTTPS with a host as none, so `meetingLinkCandidates` reads the location and the description in its place, and `meetingLinkCandidates` ends an address at an HTML character reference such as `&nbsp;` or `&quot;` and reads `&#38;` and `&#x26;` as `&`, as it read `&amp;`.
