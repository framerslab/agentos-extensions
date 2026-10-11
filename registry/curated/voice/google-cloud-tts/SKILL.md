---
name: google-cloud-tts
description: Text-to-speech synthesis via Google Cloud Text-to-Speech API
category: voice
---

# Google Cloud TTS

Text-to-speech synthesis using the Google Cloud Text-to-Speech API with MP3 output.

## Setup

Set `GOOGLE_CLOUD_TTS_CREDENTIALS` in your agent secrets store, or in the environment: the variable is read when no secret gives a value.
Accepts the service-account key itself as a JSON object, or the path of a service-account JSON key file, which must exist when the pack loads. The client is given the path as written (links kept, so a Kubernetes Secret volume that is updated later still opens); a path whose `..` follows a link, and so reaches another file than the client would open, is refused.
A value that is neither is refused when the pack loads, with a message that quotes none of it. In a `.env` file, the key may stand unquoted, in single quotes, or in double quotes (where dotenv turns its `\n` escapes into line breaks, which the pack reads back).
Leave it unset to use Google's Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or the metadata server on Google Cloud).

## Features

- MP3 audio output (audio/mpeg)
- Configurable language code and voice name
- `listAvailableVoices()` returns AgentOS `SpeechVoice` entries (`id`, `name`, `lang`, `provider`, lowercase `gender`)
- Credential resolution identical to the STT pack (an inline key or a key file path)

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
