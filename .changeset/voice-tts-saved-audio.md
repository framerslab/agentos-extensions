---
'@framers/agentos-ext-voice-synthesis': major
---

`text_to_speech` saves the audio it makes and returns its URL, runs Deepgram first, and checks what it is given.

**Breaking**

- The output is `{ audioUrl, bytes, contentType, format, provider, model, voice, characters, durationEstimateMs, notSent? }`. `audioBase64` is gone: AgentOS gives a tool's output to the model as text, so every call put the whole audio, as base64, in the next request (240 KB for 30 seconds of MP3). `text` is gone too; `characters` is its length. By default the audio is a new file in a private directory (`audioDir`, `AGENTOS_AUDIO_DIR`, or `agentos-audio-<uid>` in the temp directory, with a subdirectory for each caller) and `audioUrl` is its `file:` URL; a host passes `saveAudio` to store it and return an http(s) URL. The directory follows the image packs' rules and is checked before the provider is called.
- Under `auto`, Deepgram runs first (the pack's STT already reads its key), then OpenAI, then ElevenLabs, and a voice name picks its provider. The Ollama fallback is gone from `auto`: Ollama serves no speech endpoint, so with no key every call failed after a request to `localhost:11434`. That provider is now `openai-compatible` (`ollama` is still accepted), run only when named, at `compatibleBaseUrl` or the old `ollamaBaseUrl`.
- A named provider without its key is refused. It used to fall through to another provider, so a call for ElevenLabs could be billed to OpenAI.
- Text longer than the provider takes is refused (OpenAI 4,096 characters, Deepgram 2,000, ElevenLabs by model). It used to be cut at 5,000 without a word.
- Arguments are checked before any request: `text` a non-empty string, numbers finite and in the provider's documented range, `format` one of `mp3`, `opus`, `aac`, `flac`, `wav`. A setting the provider does not take (`stability` outside ElevenLabs, `instructions` outside `gpt-4o-mini-tts`) is not sent and is named in `notSent`.
- Default models: OpenAI `gpt-4o-mini-tts` (`tts-1` is shut down on 2027-01-06), ElevenLabs `eleven_multilingual_v2` (`eleven_monolingual_v1` is no longer listed). `eleven_v4` and `eleven_v4_turbo`, which ElevenLabs serves through Text to Dialogue, are refused.

**Also**

- All 13 OpenAI voices, and a custom voice by its id; a voice the tool does not know is no longer turned into `nova`.
- ElevenLabs honours `format` (as `output_format`) and takes `speed`. An answer's content type comes from its bytes, and one that does not start as the format asked for, such as an error page sent with status 200, is refused and not saved.
- One request has a deadline (`requestTimeoutMs`, five minutes) and a size limit (`maxAudioBytes`, 128 MiB), read as a stream.
- A provider's error comes back with any configured key replaced by `[redacted]`.
- New options: `elevenLabsBaseUrl`, `compatibleBaseUrl`, `compatibleApiKey`, `audioDir`, `saveAudio`, `maxAudioBytes`, `requestTimeoutMs`.
- `speech_to_text` reads an `audioUrl` under more of the types servers give audio and video files: `video/mpeg`, `audio/x-aac`, `audio/aiff`, `audio/x-aiff`, `audio/3gpp`, `video/3gpp`, `video/quicktime`, `audio/x-ms-wma`, `audio/x-matroska`. The exact list of #137 refused them as not audio; a `.mpeg` file goes to the provider as `audio.mpeg`.
