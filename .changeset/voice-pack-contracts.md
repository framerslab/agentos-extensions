---
"@framers/agentos-ext-streaming-stt-whisper": patch
"@framers/agentos-ext-streaming-tts-openai": patch
"@framers/agentos-ext-streaming-tts-elevenlabs": patch
"@framers/agentos-ext-voice-twilio": minor
"@framers/agentos-ext-voice-telnyx": minor
"@framers/agentos-ext-voice-plivo": minor
---

Emit the core speech events alongside the retained legacy events, drain Whisper requests before the final transcript, preserve sentence ordering during synthesis, and decode ElevenLabs JSON audio. Expose the call manager binding used by each carrier tool, support host manager injection and rebinding, and dispose only pack-owned managers. Carrier packs require the core release that supplies the binding; existing provider payloads remain usable.
