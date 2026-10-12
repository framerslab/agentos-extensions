---
'@framers/agentos-ext-voice-synthesis': minor
---

`speech_to_text` takes, as `audioUrl`, the `file:` URL of audio `text_to_speech` saved, for the caller it was saved for, so the audio one tool makes is a source for the other. The file must have the saver's name and sit in that caller's subdirectory of the audio directory, private to the service's user, under directories no other user can change. It must be a regular file with one link, at most 25 MiB, whose bytes are still the format its name says, and it is opened once without following a link: the image packs' rules for their saved images. Any other `file:` URL is refused with one message, and other local files are never read. The pack's `audioDir` option now sets the directory for both tools.
