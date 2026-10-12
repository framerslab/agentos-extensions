# Voice Synthesis Extension for AgentOS

Voice input and output tools for AgentOS:

- `text_to_speech` through Deepgram, OpenAI, ElevenLabs, or a server that speaks OpenAI's speech API
- `speech_to_text` through OpenAI Whisper, Deepgram, or a Whisper-compatible local server

## Installation

```bash
npm install @framers/agentos-ext-voice-synthesis
```

## Configuration

Set environment variables, or pass the options to the pack.

| Environment variable | Pack option | What it sets |
|---|---|---|
| `DEEPGRAM_API_KEY` | `deepgramApiKey` (secret `deepgram.apiKey`) | Deepgram, for both tools |
| `OPENAI_API_KEY` | `openaiApiKey` (secret `openai.apiKey`) | OpenAI, for both tools |
| `ELEVENLABS_API_KEY` | `elevenLabsApiKey` (secret `elevenlabs.apiKey`) | ElevenLabs speech |
| `DEEPGRAM_BASE_URL`, `OPENAI_BASE_URL` | `deepgramBaseUrl`, `openaiBaseUrl`, `elevenLabsBaseUrl` | An API base, such as a proxy. Defaults: `https://api.deepgram.com/v1`, `https://api.openai.com/v1`, `https://api.elevenlabs.io/v1` |
| | `compatibleBaseUrl`, `compatibleApiKey` | The API base of an OpenAI-compatible speech server, such as `http://localhost:8880/v1`, and its key if it wants one |
| `OLLAMA_BASE_URL` | `ollamaBaseUrl` | The old option for that server, a server root such as `http://localhost:11434`: requests go to `/v1/audio/speech` under it |
| `TTS_PROVIDER` | `defaultProvider` | `auto`, `deepgram`, `openai`, `elevenlabs` or `openai-compatible` (`ollama` is its old name) |
| `AGENTOS_AUDIO_DIR` | `audioDir` | Where speech is saved |
| | `saveAudio` | The host's own saver |
| | `maxAudioBytes`, `requestTimeoutMs` | The limits of one speech request: 128 MiB and five minutes |
| `WHISPER_LOCAL_BASE_URL` | `whisperLocalBaseUrl` | A local OpenAI-compatible transcription server |
| `STT_PROVIDER` | `defaultSttProvider` | `auto`, `openai`, `deepgram` or `whisper-local` |

## Tool: text_to_speech

Makes an audio file of the text and returns its URL. The audio itself is never in the output: AgentOS gives a tool's output to the model as text, and base64 audio there is hundreds of kilobytes in the next request.

**Input:**
- `text` (string, required): the text to speak. Text longer than the provider takes is refused, not cut: OpenAI 4,096 characters, Deepgram 2,000, ElevenLabs 5,000 (`eleven_v3`), 10,000 (`eleven_multilingual_v2`), 30,000 (`eleven_flash_v2`) or 40,000 (`eleven_flash_v2_5`).
- `provider` (string): `auto` (default), `deepgram`, `openai`, `elevenlabs` or `openai-compatible`.
- `voice` (string): OpenAI: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova` (default), `sage`, `shimmer`, `verse`, `marin`, `cedar`, or a custom voice id. ElevenLabs: `rachel` (default), `domi`, `bella`, `antoni`, `josh`, `arnold`, `adam`, `sam`, or a voice id. Deepgram: an Aura model id such as `aura-2-thalia-en` (default), or a voice name such as `thalia`, which becomes `aura-2-thalia-en`.
- `model` (string): Deepgram: an Aura model. OpenAI: `gpt-4o-mini-tts` (default), `tts-1-hd`. ElevenLabs: `eleven_multilingual_v2` (default), `eleven_v3`, `eleven_flash_v2_5`, `eleven_flash_v2`. `eleven_v4` and `eleven_v4_turbo` are refused: ElevenLabs serves them through its Text to Dialogue API.
- `format` (string): `mp3` (default), `opus`, `aac`, `flac` or `wav`. ElevenLabs makes no `aac` or `flac`.
- `speed` (number): OpenAI 0.25 to 4, Deepgram 0.7 to 1.5, ElevenLabs 0.7 to 1.2.
- `stability`, `similarity_boost` (numbers, 0 to 1): ElevenLabs only.
- `instructions` (string): OpenAI's `gpt-4o-mini-tts` only: how to speak.

A setting the provider used does not take is not sent, and the output names it in `notSent`. For Deepgram the voice is the model, so a `model` given beside another `voice` is the one that speaks, and `voice` is named there.

**Output:** `audioUrl`, `bytes`, `contentType`, `format`, `provider`, `model`, `voice`, `characters` (the length of the text), `durationEstimateMs` (at 150 words a minute), and `notSent` when a setting was not sent.

### Which provider runs

A provider that is named runs, or the call fails and says which key it needs: no other provider is tried in its place. With `auto`:

1. a voice that belongs to one provider picks it: an OpenAI voice name, an ElevenLabs name above, a Deepgram model id (`aura-...`);
2. otherwise the first with a key: Deepgram, OpenAI, ElevenLabs.

`openai-compatible` runs only when it is named, or set as `defaultProvider`. Ollama serves no speech endpoint; the option that carries its name stays for servers set up through it.

### Where the audio goes

By default the audio is saved as a new file, and `audioUrl` is its `file:` URL. The directory is `audioDir`, else `AGENTOS_AUDIO_DIR`, else `agentos-audio-<uid>` in the temp directory (on Windows, `AppData\Local\Temp\agentos-audio` in the user's profile). Each caller (`userContext.userId`) has a subdirectory of its own. The pack deletes nothing: the host clears the directory, and the operating system clears the default one.

- The directory, and each caller's directory in it, must belong to the service's user with no one else able to write it. Every directory above it must belong to that user or to root and be writable by no one else, unless it is sticky, as `/tmp` is: a user who could rename an entry in one of them could swap the tree between a check and the write, and receive another caller's speech. All of this is made and checked before the provider is called, so a directory that is refused costs no synthesis; the error names the directory, its owner and its mode.
- In Kubernetes, a disk-backed `emptyDir` is 0777 without the sticky bit, and a volume under a pod `fsGroup` is group-writable, so an audio directory anywhere inside one is refused. Make the mount sticky (`chmod 1777` in an init container, or `emptyDir.mode: 01777` on a cluster with the alpha `EmptyDirVolumeMode` feature gate, Kubernetes 1.37 and later), give it to the service's user, or pass `saveAudio`.
- On Windows, Node reads no ACLs: only the directories' kind is checked, and an `audioDir` you set must be private by its ACL.
- A `file:` URL names a file on the machine that ran the tool. A host whose clients are elsewhere passes `saveAudio`: a function that gets `{ bytes, contentType, tool, context }`, stores the audio, and returns the http(s) URL its clients load, at most 2,048 characters. With it, nothing is written to disk.

### Limits and errors

One request has five minutes (`requestTimeoutMs`) and may answer with at most 128 MiB (`maxAudioBytes`); both must be positive whole numbers. An answer that does not start as the format asked for, such as an error page sent with status 200, is refused and not saved. A provider's error comes back with its status and the first 300 characters of its body, with any configured key replaced by `[redacted]`.

The saved file is for the host to play or serve, and `speech_to_text` takes its `file:` URL as `audioUrl` for the caller it was saved for (below).

## Tool: speech_to_text

**Providers:**
- `openai` — hosted Whisper via `OPENAI_API_KEY`
- `deepgram` — hosted Deepgram STT via `DEEPGRAM_API_KEY`
- `whisper-local` — local OpenAI-compatible transcription endpoint via `WHISPER_LOCAL_BASE_URL`
- `auto` — prefers OpenAI, then Deepgram, then explicitly configured local STT

**Input:**
- `audioBase64` (string) — Base64 audio payload, optionally as a `data:` URL
- `audioUrl` (string) — The http(s) URL of audio on a public host, at most 25 MiB. It is read through AgentOS's `guardedFetch` (the pack needs `@framers/agentos` 0.13.44 or later): every address the host resolves to must be public, each redirect is checked the same way, only ports 80 and 443 are read, and the read stops at 30 seconds. Addresses on this machine or a private network are refused, with one message whether the host is refused or does not resolve. The server must answer with an audio or video type the tool lists (among them `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/webm`, `audio/ogg`, `application/ogg`, `audio/flac`, `audio/aac`, `audio/x-aac`, `audio/aiff`, `video/mp4`, `video/mpeg`, `video/webm`, `video/quicktime`) or with `application/octet-stream`; whether the provider reads the format is the provider's answer. With an AgentOS that has no `guardedFetch` an http(s) `audioUrl` is refused; `audioBase64` still works.
  `audioUrl` may also be the `file:` URL of audio `text_to_speech` saved, for the caller it was saved for (`userContext.userId`), read from the same `audioDir`. The file must have the saver's name and sit in that caller's subdirectory, private to the service's user, under directories no other user can change. It must be a regular file with one link, at most 25 MiB, whose bytes are still the format its name says. It is opened once, without following a link. Any other `file:` URL is refused with one message, which does not say which files exist; other local files are never read. These are the image packs' rules for their saved images.
- `provider` (string, optional) — `auto`, `openai`, `deepgram`, or `whisper-local`
- `mimeType` (string, optional) — For example `audio/wav`
- `fileName` (string, optional) — File name sent to the provider
- `format` (string, optional) — Audio format hint such as `wav`, `mp3`, `m4a`, `webm`
- `language` (string, optional) — ISO language hint
- `prompt` (string, optional) — Context prompt to bias transcription
- `model` (string, optional) — Provider model override such as `whisper-1`, `nova-2`, or `base`
- `temperature` (number, optional) — Whisper temperature override
- `responseFormat` (string, optional) — `json`, `text`, `srt`, `verbose_json`, or `vtt`
- `diarize` (boolean, optional) — Enable speaker diarization where supported
- `utterances` (boolean, optional) — Request utterance segmentation where supported
- `smartFormat` (boolean, optional) — Enable provider-side formatting where supported
- `detectLanguage` (boolean, optional) — Enable provider-side language detection where supported

**Output:** Transcribed text, provider/model metadata, language, optional confidence, duration, and optional segments.

`whisper-local` targets OpenAI-compatible local transcription servers. That
keeps the tool contract stable even when you swap between hosted Whisper,
Deepgram, and local runtimes behind the same API shape.

## License

Apache-2.0 - Frame.dev
