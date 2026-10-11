# Voice Synthesis Extension for AgentOS

Voice input/output tools for AgentOS:

- `text_to_speech` via OpenAI, ElevenLabs, or a local Ollama-compatible runtime
- `speech_to_text` via OpenAI Whisper, Deepgram, or Whisper-local/OpenAI-compatible local STT runtimes

## Installation

```bash
npm install @framers/agentos-ext-voice-synthesis
```

## Configuration

Set one or more of the following environment variables, or pass them via
extension options:

- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `DEEPGRAM_API_KEY`
- `OLLAMA_BASE_URL` for a local OpenAI-compatible TTS runtime
- `WHISPER_LOCAL_BASE_URL` for a local OpenAI-compatible STT runtime
- `TTS_PROVIDER` to prefer `openai`, `elevenlabs`, `ollama`, or `auto`
- `STT_PROVIDER` to prefer `openai`, `deepgram`, `whisper-local`, or `auto`
- `OPENAI_BASE_URL` for OpenAI-compatible speech endpoints

## Tool: text_to_speech

**Input:**
- `text` (string, required) — Text to convert, max 5000 chars
- `provider` (string, optional) — `openai`, `elevenlabs`, `ollama`, or `auto`
- `voice` (string, optional) — OpenAI: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`; ElevenLabs: `rachel`, `domi`, `bella`, `antoni`, `josh`, `arnold`, `adam`, `sam`
- `model` (string, optional) — OpenAI: `tts-1`, `tts-1-hd`; ElevenLabs: `eleven_monolingual_v1`, `eleven_multilingual_v2`
- `speed` (number, OpenAI only) — 0.25 to 4.0
- `stability` (number, ElevenLabs only) — 0 to 1
- `similarity_boost` (number, ElevenLabs only) — 0 to 1
- `format` (string) — `mp3`, `opus`, `aac`, `flac`, `wav`

**Output:** Base64-encoded audio, provider metadata, and a duration estimate.

## Provider selection

The tool prefers providers in this order when `provider` is omitted:

1. OpenAI, if `OPENAI_API_KEY` is set
2. ElevenLabs, if `ELEVENLABS_API_KEY` is set
3. Ollama-compatible local runtime as a best-effort fallback

Ollama support is experimental and assumes an OpenAI-compatible TTS endpoint at
`/v1/audio/speech`.

## Tool: speech_to_text

**Providers:**
- `openai` — hosted Whisper via `OPENAI_API_KEY`
- `deepgram` — hosted Deepgram STT via `DEEPGRAM_API_KEY`
- `whisper-local` — local OpenAI-compatible transcription endpoint via `WHISPER_LOCAL_BASE_URL`
- `auto` — prefers OpenAI, then Deepgram, then explicitly configured local STT

**Input:**
- `audioBase64` (string) — Base64 audio payload, optionally as a `data:` URL
- `audioUrl` (string) — The http(s) URL of audio on a public host, at most 25 MiB. It is read through AgentOS's `guardedFetch` (`@framers/agentos` 0.13.35 or later): every address the host resolves to must be public, each redirect is checked the same way, only ports 80 and 443 are read, and the read stops at 30 seconds. Addresses on this machine or a private network are refused, with one message whether the host is refused or does not resolve. With an older AgentOS an `audioUrl` is refused; `audioBase64` still works.
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
