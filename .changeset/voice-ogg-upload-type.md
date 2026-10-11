---
'@framers/agentos-ext-voice-synthesis': patch
---

`speech_to_text` reads an `audioUrl` whose server labels it `application/ogg`, the type RFC 5334 gives any Ogg file. The guarded read refused it as not audio, so Ogg from such a server could not be transcribed even with `mimeType: 'audio/ogg'` given. Ogg is sent to the provider as `audio/ogg`, and the upload's file name takes its extension from the other names servers give audio as well (`audio/mp3`, `audio/x-m4a`, `audio/x-flac`, `video/mp4`, `video/webm`, and a type with parameters such as `audio/ogg; codecs=opus`), where it used to fall back to `.wav`.
