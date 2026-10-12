# @framers/agentos-ext-voice-synthesis

## 3.0.1

### Patch Changes

- [#161](https://github.com/framerslab/agentos-extensions/pull/161) [`e07d553`](https://github.com/framerslab/agentos-extensions/commit/e07d55391650ecb78ae5642584864f14294cf786) Thanks [@jddunn](https://github.com/jddunn)! - `text_to_speech` finds the configured keys in a provider's error body as it was read, before it cuts the body to the 300 characters an error shows. Replaced first and cut after, a key that ran across the cut kept its first characters, and so could a key the 4 KiB read cut off once earlier keys were taken out and the text moved up. Now every whole key, and a key the read cut off at its end, is masked where it was read, and the error shows the first 300 characters with each masked run as `[redacted]`.

## 3.0.0

### Major Changes

- [#137](https://github.com/framerslab/agentos-extensions/pull/137) [`d96b626`](https://github.com/framerslab/agentos-extensions/commit/d96b6263d718f8d7b6f031273e59db550a6447a0) Thanks [@jddunn](https://github.com/jddunn)! - `speech_to_text` reads an `audioUrl` through AgentOS's `guardedFetch` instead of a plain `fetch`.
  
  The model writes the URL, and the plain fetch followed it anywhere: `http://169.254.169.254/` (where cloud metadata services answer), a service on the server's own network, any redirect, with no size or time limit, and handed what came back to the transcription provider. The error even reported each internal address's HTTP status. Now every address the host resolves to must be public, each redirect is checked the same way, only ports 80 and 443 are read, the audio is held to 25 MiB and the read to 30 seconds, and a refused host and one that does not resolve give the same message. **Breaking: the pack now needs `@framers/agentos` 0.13.44 or later** (its peer range was `>=0.10.40`), which is why this is a major: an install that pins an older AgentOS beside a `^2` range of this pack would otherwise take the new floor and stop on the peer conflict: `guardedFetch` came in 0.13.35, and 0.13.44 counts the body on the wire and reads the network's NAT64 prefixes. An install with an AgentOS that has no `guardedFetch` refuses an `audioUrl` and still takes `audioBase64`.

- [#146](https://github.com/framerslab/agentos-extensions/pull/146) [`fddb9d6`](https://github.com/framerslab/agentos-extensions/commit/fddb9d65a8af336b5b6c4e194e8d02a4aa39ab3f) Thanks [@jddunn](https://github.com/jddunn)! - `text_to_speech` saves the audio it makes and returns its URL, runs Deepgram first, and checks what it is given.
  
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

### Patch Changes

- [#144](https://github.com/framerslab/agentos-extensions/pull/144) [`6e1ee73`](https://github.com/framerslab/agentos-extensions/commit/6e1ee73a79f951b37baadc870e0ddab5e456489a) Thanks [@jddunn](https://github.com/jddunn)! - `speech_to_text` reads an `audioUrl` whose server labels it `application/ogg`, the type RFC 5334 gives any Ogg file. The guarded read refused it as not audio, so Ogg from such a server could not be transcribed even with `mimeType: 'audio/ogg'` given. Ogg is sent to the provider as `audio/ogg`, and the upload's file name takes its extension from the other names servers give audio as well (`audio/mp3`, `audio/x-m4a`, `audio/x-flac`, `video/mp4`, `video/webm`, and a type with parameters such as `audio/ogg; codecs=opus`), where it used to fall back to `.wav`.

## 2.1.1

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 2.1.0

### Minor Changes

- [#77](https://github.com/framerslab/agentos-extensions/pull/77) [`91fd410`](https://github.com/framerslab/agentos-extensions/commit/91fd4108cca945cdb37cb541b1d88e68454f76a1) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
