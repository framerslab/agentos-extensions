---
'@framers/agentos-ext-vision-pipeline': minor
---

`handwriting` at maxTier 3 reads the whole page: the cloud model is asked to transcribe it, beside TrOCR.

TrOCR is a single-line model (it sees the whole image at 384 by 384 pixels and stops at 20 tokens), so a page of handwriting came back as a few words. Where the cloud is allowed, the call now names the cloud tier too and asks it for a transcription with AgentOS's `cloudTask: 'transcribe'`, the text alone and not the description its default prompt gives; its text is returned unless it finds none, in which case TrOCR's stands. `maxTier: 2` stays on this machine and reads one line. The mode's description in the tool's schema says so.

**The pack now needs `@framers/agentos` 0.13.50 or later**, the release that added `cloudTask`: on an older one the option would be ignored and the cloud model's description would replace the transcription.
