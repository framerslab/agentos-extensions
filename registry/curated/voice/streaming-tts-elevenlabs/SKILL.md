---
name: streaming-tts-elevenlabs
description: Streaming text-to-speech via ElevenLabs WebSocket API with real-time audio generation
category: voice
---

# ElevenLabs Streaming TTS

Low-latency streaming text-to-speech using the ElevenLabs WebSocket Streaming API. Maintains a
persistent WebSocket connection per session and streams audio chunks as MP3 data as soon as each
sentence boundary is reached, enabling near-instant audio playback.

## Setup

Set `ELEVENLABS_API_KEY` in your environment or agent secrets store.

## Features

- Persistent WebSocket connection per session (no per-request HTTP overhead)
- Real-time audio streaming: ElevenLabs generates and sends audio as tokens arrive
- Automatic sentence-boundary flushing (`.`, `?`, `!`) for low-latency output
- Configurable voice via ElevenLabs voice ID
- Configurable model (eleven_turbo_v2 for low latency, eleven_multilingual_v2 for quality)
- Voice settings: stability, similarity boost, style, speaker boost
- MP3 output at 44.1 kHz / 128 kbps

## Configuration

In `agent.config.json`:

```json
{
  "voice": {
    "tts": "elevenlabs"
  }
}
```

Provider-specific options via `providerOptions`:

```json
{
  "voice": {
    "tts": "elevenlabs",
    "providerOptions": {
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "modelId": "eleven_turbo_v2",
      "stability": 0.5,
      "similarityBoost": 0.75,
      "style": 0.0,
      "useSpeakerBoost": true
    }
  }
}
```

## Events

| Event                | Payload                 | Description                                        |
|----------------------|-------------------------|----------------------------------------------------|
| `audio`              | `EncodedAudioChunk`     | Core audio event; same MP3 chunk as `audio_chunk`  |
| `audio_chunk`        | `EncodedAudioChunk`     | MP3 audio buffer ready for playback                |
| `utterance_complete` | `{ text, durationMs }`  | ElevenLabs signalled final audio generation done   |
| `flush_complete`     | (none)                  | Remote final received; synthesis complete          |
| `cancelled`          | `{ remaining: string }` | Session was cancelled; remaining text not rendered |
| `error`              | `Error`                 | WebSocket or synthesis error                       |
| `close`              | —                       | Session fully terminated                           |
