---
'@framers/agentos-ext-google-cloud-tts': patch
---

The Google Cloud TTS pack accepts `@google-cloud/text-to-speech` 5, 6 and 7 as its peer, and is tested against 7. Versions 6.0.0 and 7.0.0 changed only the Node.js floor, to 18 and then 22 (the package's CHANGELOG); `TextToSpeechClient`, `synthesizeSpeech` and `listVoices`, the calls the pack makes, are the same in all three. An install on 5 is not refused.
