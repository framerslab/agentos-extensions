---
name: streaming-tts-openai
description: Streaming text-to-speech via OpenAI Audio Speech API with adaptive sentence chunking
category: voice
---

# OpenAI Streaming TTS

Low-latency streaming text-to-speech using OpenAI's TTS API. Buffers incoming LLM tokens into
natural sentence chunks before making API requests, enabling audio playback to begin within
the first sentence rather than waiting for full LLM output.

## Setup

Set `OPENAI_API_KEY` in your environment or agent secrets store.

## Features

- Adaptive sentence chunking: emits audio after each `.`, `?`, `!`, or `;` boundary
- Fallback flush timer (default 2 000 ms) for fragments without punctuation
- Sequential synthesis: each sentence is requested after its predecessor finishes, so audio stays in input order
- AbortController-based cancellation for all in-flight requests
- Supports all OpenAI TTS voices: alloy, echo, fable, onyx, nova, shimmer
- Configurable model (tts-1, tts-1-hd) and output format (opus, mp3, aac, flac, wav, pcm)

## Configuration

In `agent.config.json`:

```json
{
  "voice": {
    "tts": "openai"
  }
}
```

Provider-specific options via `providerOptions`:

```json
{
  "voice": {
    "tts": "openai",
    "providerOptions": {
      "model": "tts-1",
      "voice": "nova",
      "format": "opus",
      "maxBufferMs": 2000
    }
  }
}
```

## Events

| Event                | Payload                 | Description                                        |
|----------------------|-------------------------|----------------------------------------------------|
| `utterance_start`    | `{ text: string }`      | Sentence chunk dispatched for synthesis            |
| `audio`              | `EncodedAudioChunk`     | Core audio event; PCM (raw or WAV), MP3 or Opus    |
| `audio_chunk`        | `EncodedAudioChunk`     | Synthesized audio buffer ready for playback        |
| `utterance_complete` | `{ text, durationMs }`  | Synthesis complete for a sentence chunk            |
| `flush_complete`     | (none)                  | Flushed batch synthesized without an error         |
| `cancelled`          | `{ remaining: string }` | Session was cancelled; remaining text not rendered |
| `error`              | `Error`                 | Synthesis request failed                           |
| `close`              | —                       | Session fully terminated                           |
