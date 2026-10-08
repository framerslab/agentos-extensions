---
name: google-cloud-stt
description: Batch speech-to-text via Google Cloud Speech-to-Text API
category: voice
---

# Google Cloud STT

Batch speech-to-text recognition using Google Cloud Speech-to-Text V1 API.

## Setup

Provide credentials via the `GOOGLE_CLOUD_STT_CREDENTIALS` secret. Accepts either:
- The service-account key itself, as a JSON object
- A path to a service-account JSON key file (any other value)

Leave the secret unset to use Google's Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or the metadata server on Google Cloud).

## Features

- WAV and FLAC files (detected from the bytes; Google reads the encoding and sample rate from the header) and raw LINEAR16 PCM, whatever MIME type the caller declares
- Configurable language code (BCP-47)
- Returns the AgentOS `SpeechTranscriptionResult`: `text` (each stretch's most likely transcript, in order), mean `confidence`, `isFinal`, and `segments` with timing when Google reports end times
- Batch only (`supportsStreaming: false`)

## Configuration

In `agent.config.json`:

```json
{
  "voice": {
    "stt": "google-cloud-stt"
  }
}
```

Provider-specific options via `providerOptions`:

```json
{
  "voice": {
    "stt": "google-cloud-stt",
    "providerOptions": {
      "language": "fr-FR"
    }
  }
}
```
