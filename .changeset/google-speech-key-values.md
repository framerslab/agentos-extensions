---
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
---

The Google Cloud STT and TTS packs refuse a credentials value that is neither a service-account key as a JSON object nor the path of an existing file, when the pack loads, with a message that quotes none of the value. A malformed inline key, such as one whose quotes a `.env` file left escaped, was passed on as a key file path, and the first call's error then carried the key in its message. A key given in double quotes in a `.env` file, whose `\n` escapes dotenv turns into line breaks, is read again.
