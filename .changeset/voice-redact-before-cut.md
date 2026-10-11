---
'@framers/agentos-ext-voice-synthesis': patch
---

`text_to_speech` takes the configured keys out of a provider's error body before it cuts the body to 300 characters. Cut first, a key that ran across the cut kept its first characters in the error, since only a whole key is replaced.
