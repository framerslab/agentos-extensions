---
name: google-cloud-tts
description: Text-to-speech synthesis via Google Cloud Text-to-Speech API
category: voice
---

# Google Cloud TTS

Text-to-speech synthesis using the Google Cloud Text-to-Speech API with MP3 output.

## Setup

Set `GOOGLE_CLOUD_TTS_CREDENTIALS` in your environment or agent secrets store.
Accepts an absolute path to a service-account JSON key file or an inline JSON credentials string.
Leave it unset to use Google's Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or the metadata server on Google Cloud).

## Features

- MP3 audio output (audio/mpeg)
- Configurable language code and voice name
- `listAvailableVoices()` returns AgentOS `SpeechVoice` entries (`id`, `name`, `lang`, `provider`, lowercase `gender`)
- Credential resolution identical to the STT pack (path or JSON string)

## Configuration

In `agent.config.json`:

```json
{
  "voice": {
    "tts": "google-cloud-tts"
  }
}
```

Provider-specific options:

```json
{
  "voice": {
    "tts": "google-cloud-tts",
    "providerOptions": {
      "languageCode": "en-GB",
      "voice": "en-GB-Neural2-A"
    }
  }
}
```
