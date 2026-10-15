---
name: streaming-stt-whisper
description: Chunked sliding-window streaming speech-to-text via OpenAI Whisper HTTP API
category: voice
---

# Whisper Chunked Streaming STT

Streaming speech-to-text using OpenAI's Whisper model via the `/v1/audio/transcriptions` HTTP API.
Audio is accumulated in a sliding-window ring buffer and sent as 1-second WAV chunks with 200 ms
overlap for continuity.

## Setup

Set `OPENAI_API_KEY` in your environment or agent secrets store.

## Features

- Works with any OpenAI-compatible Whisper endpoint (e.g. local Faster-Whisper, Groq, OpenRouter)
- Sliding-window ring buffer: 1 s chunks, 200 ms overlap to prevent word boundary clipping
- Inline WAV encoding — zero runtime dependencies (no `ws`, no native binaries)
- Previous chunk transcript forwarded as `prompt` for cross-chunk continuity
- Simple RMS energy detector emits `speech_start` / `speech_end` events
- On fetch failure, emits `error` and continues processing — no session crash

## Configuration

In `agent.config.json`:

```json
{
  "voice": {
    "stt": "whisper"
  }
}
```

Provider-specific options via `providerOptions`:

```json
{
  "voice": {
    "stt": "whisper",
    "providerOptions": {
      "model": "whisper-1",
      "language": "en",
      "baseUrl": "https://api.openai.com"
    }
  }
}
```

## Events

| Event                  | Payload           | Description                                     |
|------------------------|-------------------|-------------------------------------------------|
| `transcript`           | `TranscriptEvent` | Core event; interim per chunk, final on flush() |
| `interim_transcript`   | `TranscriptEvent` | Emitted after each chunk is transcribed         |
| `final_transcript`     | `TranscriptEvent` | Emitted after flush() completes                 |
| `speech_start`         | —                 | RMS energy crossed threshold (0.01)             |
| `speech_end`           | —                 | RMS energy dropped below threshold              |
| `error`                | `Error`           | Fetch failure (session continues)               |
| `close`                | —                 | Session fully terminated                        |
