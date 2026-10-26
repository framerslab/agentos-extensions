# @framers/agentos-ext-streaming-stt-whisper

## 0.2.5

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The published package named no Node, so npm installed it on any release, Node 20 included, beside a core that does not support Node 20.

## 0.2.4

### Patch Changes

- [#219](https://github.com/framerslab/agentos-extensions/pull/219) [`f074690`](https://github.com/framerslab/agentos-extensions/commit/f0746905700b9e87a8178f093edf355f264df762) Thanks [@jddunn](https://github.com/jddunn)! - Emit the core speech events alongside the retained legacy events, drain Whisper requests before the final transcript, preserve sentence ordering during synthesis, and decode ElevenLabs JSON audio. Expose the call manager binding used by each carrier tool, support host manager injection and rebinding, and dispose only pack-owned managers. Carrier packs require the core release that supplies the binding; existing provider payloads remain usable.

## 0.2.3

### Patch Changes

- [#152](https://github.com/framerslab/agentos-extensions/pull/152) [`43bc75d`](https://github.com/framerslab/agentos-extensions/commit/43bc75d21b5f808ddea8d22ef7b6aac277e7799b) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

## 0.2.2

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

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
