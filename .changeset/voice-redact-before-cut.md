---
'@framers/agentos-ext-voice-synthesis': patch
---

`text_to_speech` finds the configured keys in a provider's error body as it was read, before it cuts the body to the 300 characters an error shows. Replaced first and cut after, a key that ran across the cut kept its first characters, and so could a key the 4 KiB read cut off once earlier keys were taken out and the text moved up. Now every whole key, and a key the read cut off at its end, is masked where it was read, and the error shows the first 300 characters with each masked run as `[redacted]`.
