# @framers/agentos-ext-google-cloud-stt

## 0.3.1

### Patch Changes

- [#92](https://github.com/framerslab/agentos-extensions/pull/92) [`801aff4`](https://github.com/framerslab/agentos-extensions/commit/801aff4ce0a5af94f1f58b78a0d19d52abc5abfb) Thanks [@jddunn](https://github.com/jddunn)! - Decide WAV and FLAC from the audio's bytes (a `RIFF`/`WAVE` header or the `fLaC` marker) instead of its declared MIME type. AgentOS's speech adapter labels every buffer `audio/wav`, so 0.3.0 sent headerless PCM from it without an encoding or sample rate; such audio goes as LINEAR16 again.

## 0.3.0

### Minor Changes

- [#88](https://github.com/framerslab/agentos-extensions/pull/88) [`8b8f995`](https://github.com/framerslab/agentos-extensions/commit/8b8f99586e2057a774b64a03cfc35712fbe28ccd) Thanks [@jddunn](https://github.com/jddunn)! - Implement the AgentOS speech provider contract. Both providers gain `getProviderName()`, `displayName` and `supportsStreaming: false`; without `getProviderName()` an AgentOS fallback chain that started with either threw. Google Cloud STT's `transcribe()` returns the AgentOS `SpeechTranscriptionResult` (`text` from each stretch's most likely transcript, in order, plus `confidence`, `isFinal`, `cost` and timed `segments`) instead of an array of `{ transcript, confidence, isFinal }`, so the AgentOS speech adapter reads its text; and for WAV and FLAC input it leaves the encoding and sample rate to the file header, which Google requires to match. Google Cloud TTS's `listAvailableVoices()` returns AgentOS `SpeechVoice` entries (`lang`, `provider`, lowercase `gender`). Both SKILL.md files describe Application Default Credentials.

## 0.2.1

### Patch Changes

- [#78](https://github.com/framerslab/agentos-extensions/pull/78) [`d9561f1`](https://github.com/framerslab/agentos-extensions/commit/d9561f17043bb4953732d9599fe0a2a7c387394d) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.2.0

### Minor Changes

- [`63a0b28`](https://github.com/framerslab/agentos-extensions/commit/63a0b286ba70176d09a1c073c4b496234e2f20b6) Thanks [@jddunn](https://github.com/jddunn)! - Complete voice pipeline extension packs:

  Streaming Pipeline:

  - Deepgram real-time STT via WebSocket API
  - Whisper chunked streaming STT with sliding window buffer
  - OpenAI streaming TTS with adaptive sentence chunking
  - ElevenLabs streaming TTS via WebSocket with continuation hints
  - Speaker diarization with provider delegation and local x-vector clustering
  - Semantic endpoint detection with LLM turn-completeness classifier

  Provider Ecosystem:

  - Google Cloud STT and TTS
  - Amazon Polly neural TTS
  - Vosk local offline STT
  - Piper local offline TTS (C++ binary)
  - Porcupine wake-word detection
  - OpenWakeWord ONNX wake-word detection
