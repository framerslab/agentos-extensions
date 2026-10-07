---
'@framers/agentos-ext-content-policy-rewriter': patch
'@framers/agentos-ext-ml-classifiers': patch
'@framers/agentos-ext-topicality': patch
'@framers/agentos-ext-browser-automation': patch
'@framers/agentos-ext-cli-executor': minor
'@framers/agentos-ext-credential-vault': patch
'@framers/agentos-ext-agent-delegation': patch
'@framers/agentos-ext-tool-bulk-scheduler': patch
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-image-generation': minor
'@framers/agentos-ext-local-file-search': patch
'@framers/agentos-ext-tool-media-upload': patch
'@framers/agentos-ext-tool-multi-channel-post': patch
'@framers/agentos-ext-send-file-to-channel': patch
'@framers/agentos-ext-tool-site-deploy': patch
'@framers/agentos-ext-tool-social-analytics': patch
'@framers/agentos-ext-vision-pipeline': patch
'@framers/agentos-ext-wallet': patch
'@framers/agentos-ext-zip-files': patch
'@framers/agentos-ext-amazon-polly': patch
'@framers/agentos-ext-diarization': patch
'@framers/agentos-ext-endpoint-semantic': patch
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
'@framers/agentos-ext-openwakeword': patch
'@framers/agentos-ext-piper': patch
'@framers/agentos-ext-voice-plivo': patch
'@framers/agentos-ext-porcupine': patch
'@framers/agentos-ext-streaming-stt-deepgram': patch
'@framers/agentos-ext-streaming-stt-whisper': patch
'@framers/agentos-ext-streaming-tts-elevenlabs': patch
'@framers/agentos-ext-streaming-tts-openai': patch
'@framers/agentos-ext-voice-telnyx': patch
'@framers/agentos-ext-voice-twilio': patch
'@framers/agentos-ext-vosk': patch
---

Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
