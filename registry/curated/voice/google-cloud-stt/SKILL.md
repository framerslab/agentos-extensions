---
name: google-cloud-stt
description: Batch speech-to-text via Google Cloud Speech-to-Text API
category: voice
---

# Google Cloud STT

Batch speech-to-text recognition using Google Cloud Speech-to-Text V1 API.

## Setup

Provide credentials via the `GOOGLE_CLOUD_STT_CREDENTIALS` secret, or the environment variable of the same name when no secret gives one. Accepts either:
- The service-account key itself, as a JSON object
- The path of a service-account JSON key file, which must exist when the pack loads. The client is given the path as written (links kept, so a Kubernetes Secret volume that is updated later still opens); a path whose `..` follows a link, and so reaches another file than the client would open, is refused

A value that is neither is refused when the pack loads, with a message that quotes none of it. In a `.env` file, the key may stand unquoted, in single quotes, or in double quotes (where dotenv turns its `\n` escapes into line breaks, which the pack reads back).

Leave both unset to use Google's Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or the metadata server on Google Cloud).

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
