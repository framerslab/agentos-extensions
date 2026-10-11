---
'@framers/agentos-ext-voice-synthesis': minor
---

`speech_to_text` reads an `audioUrl` through AgentOS's `guardedFetch` instead of a plain `fetch`.

The model writes the URL, and the plain fetch followed it anywhere: `http://169.254.169.254/` (where cloud metadata services answer), a service on the server's own network, any redirect, with no size or time limit, and handed what came back to the transcription provider. The error even reported each internal address's HTTP status. Now every address the host resolves to must be public, each redirect is checked the same way, only ports 80 and 443 are read, the audio is held to 25 MiB and the read to 30 seconds, and a refused host and one that does not resolve give the same message. An `audioUrl` needs `@framers/agentos` 0.13.35 or later; with an older AgentOS it is refused, and `audioBase64` still works.
