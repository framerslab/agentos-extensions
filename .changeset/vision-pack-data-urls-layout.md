---
'@framers/agentos-ext-vision-pipeline': patch
---

The vision-pipeline tool reads a data URL as AgentOS's `imageToBuffer` does: it drops tabs and line breaks first, and decodes base64 when `;base64`, with spaces around it allowed, ends the media type. `data:image/png; base64,...`, `data:image/png;base64 ,...` and their tab and line-break spellings reached the pipeline as the bytes of their base64 text. The tool also returns the pipeline's `layout`, a text block per line with its box, and `failedTiers`, each tier that was due to run and failed with its error.
