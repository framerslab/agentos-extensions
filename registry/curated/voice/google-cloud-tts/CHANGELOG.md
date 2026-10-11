# @framers/agentos-ext-google-cloud-tts

## 0.3.4

### Patch Changes

- [#136](https://github.com/framerslab/agentos-extensions/pull/136) [`0c1267d`](https://github.com/framerslab/agentos-extensions/commit/0c1267d0e2ede7dc4b016facc07d021a0a2d3c46) Thanks [@jddunn](https://github.com/jddunn)! - The Google speech packs hand the client the key file's path as written, and read the credentials variable from the environment.
  
  - A key file is given to the client by its path, made absolute and with its links kept, after a check that the path as the file system reads it and as the client reads it reach the same file. The real path, which #124 handed on, stopped opening on a Kubernetes Secret volume at its next update: the kubelet links each file through a timestamped directory that an update replaces and removes. A path whose `..` follows a link, and so reaches two files, is refused with a message that quotes none of it. The check needs no `realpath(3)`, which on musl needs `/proc`.
  - `GOOGLE_CLOUD_STT_CREDENTIALS` and `GOOGLE_CLOUD_TTS_CREDENTIALS` are read from the environment when no secret gives them. AgentOS's extension manager reads the environment only for the ids in its own catalog, which has neither, so a variable set as SKILL.md said left the client on Application Default Credentials without a word.

## 0.3.3

### Patch Changes

- [#124](https://github.com/framerslab/agentos-extensions/pull/124) [`2d124c5`](https://github.com/framerslab/agentos-extensions/commit/2d124c5ee97c8cfbb17a3fc878f8fbf7f01867a1) Thanks [@jddunn](https://github.com/jddunn)! - A key file path is handed to the Google client as the real path of the file that was checked. A path through a link followed by `..` (`/keys/link/../sa.json`) was checked as the file the file system reaches and then opened as a different one, the path with `link/..` removed as text, so the client could sign in with another key.

- [#117](https://github.com/framerslab/agentos-extensions/pull/117) [`72abbe8`](https://github.com/framerslab/agentos-extensions/commit/72abbe8a0aaac6d1f093494e7e809f2c4e98e1ab) Thanks [@jddunn](https://github.com/jddunn)! - The Google Cloud STT and TTS packs refuse a credentials value that is neither a service-account key as a JSON object nor the path of an existing file, when the pack loads, with a message that quotes none of the value. A malformed inline key, such as one whose quotes a `.env` file left escaped, was passed on as a key file path, and the first call's error then carried the key in its message. A key given in double quotes in a `.env` file, whose `\n` escapes dotenv turns into line breaks, is read again. A relative key file path is resolved when the pack loads, so a later change of working directory does not move it.

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.3.2

### Patch Changes

- [#101](https://github.com/framerslab/agentos-extensions/pull/101) [`b915381`](https://github.com/framerslab/agentos-extensions/commit/b9153818afc2afbe751b45f80677856ede999ce9) Thanks [@jddunn](https://github.com/jddunn)! - Image editing and vision refuse image URLs on this machine or a private network (localhost, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT ranges, their IPv6 forms) and send the trimmed source they checked. Vision decodes a percent-encoded data URL byte by byte without throwing, logs a pipeline that fails to release, and gives the cloud tier the OpenAI key from its options or secrets; style transfer gets the chosen provider's key. Both keys take effect from `@framers/agentos` 0.12.14. The Google Cloud speech packs read a credentials value as an inline key only when it opens like a JSON object, so a key file path such as `{keys}/sa.json` loads again.

## 0.3.1

### Patch Changes

- [#95](https://github.com/framerslab/agentos-extensions/pull/95) [`c8c5ae6`](https://github.com/framerslab/agentos-extensions/commit/c8c5ae6e3f1dc36d10e98ad1c212a0d919780bcb) Thanks [@jddunn](https://github.com/jddunn)! - An inline service-account key works. The credentials secret is a key when it starts with `{` and a key file path otherwise. Every real key holds `/` and `\`, which the packs took as the mark of a path, so they opened an inline key as a file and the first call failed with an error that quoted the key. A key that starts with `{` but is not valid JSON now fails when the pack loads, with a message that quotes none of it.

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
