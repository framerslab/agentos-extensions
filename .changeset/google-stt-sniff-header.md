---
'@framers/agentos-ext-google-cloud-stt': patch
---

Decide WAV and FLAC from the audio's bytes (a `RIFF`/`WAVE` header or the `fLaC` marker) instead of its declared MIME type. AgentOS's speech adapter labels every buffer `audio/wav`, so 0.3.0 sent headerless PCM from it without an encoding or sample rate; such audio goes as LINEAR16 again.
