---
'@framers/agentos-ext-calendar-google': major
---

The pack is an ES module, and a typed read surface ships on `@framers/agentos-ext-calendar-google/reader` for a host that keeps its own grant: `GoogleCalendarReader` (the windowed read with every page and its sync token, the incremental read with a 410 answered as gone, the read by id, one deadline and a size cap on every answer, the caller's cancellation, fixed failure words), `mapCalendarEvent` and `meetingLinkCandidates`. The tools and their behaviour are unchanged; a CommonJS `require()` of the pack is no longer supported. The `@framers/agentos` peer floor is 0.13.144.
