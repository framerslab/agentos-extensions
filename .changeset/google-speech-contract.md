---
'@framers/agentos-ext-google-cloud-stt': minor
'@framers/agentos-ext-google-cloud-tts': minor
---

Implement the AgentOS speech provider contract. Both providers gain `getProviderName()`, `displayName` and `supportsStreaming: false`; without `getProviderName()` an AgentOS fallback chain that started with either threw. Google Cloud STT's `transcribe()` returns the AgentOS `SpeechTranscriptionResult` (`text` from each stretch's most likely transcript, in order, plus `confidence`, `isFinal`, `cost` and timed `segments`) instead of an array of `{ transcript, confidence, isFinal }`, so the AgentOS speech adapter reads its text; and for WAV and FLAC input it leaves the encoding and sample rate to the file header, which Google requires to match. Google Cloud TTS's `listAvailableVoices()` returns AgentOS `SpeechVoice` entries (`lang`, `provider`, lowercase `gender`). Both SKILL.md files describe Application Default Credentials.
