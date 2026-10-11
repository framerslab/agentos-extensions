---
'@framers/agentos-ext-image-generation': minor
'@framers/agentos-ext-image-editing': minor
'@framers/agentos-ext-vision-pipeline': patch
---

An image a provider leaves at a URL of its own is saved too, so the reference in the result keeps working.

- The image tools saved the image data OpenAI and Stability answer with, and passed Replicate's URL on as it was. Replicate deletes an API prediction's output files after an hour (https://replicate.com/docs/topics/predictions/output-files), so an hour later the image in the conversation was gone and the URL could not be the source of a later edit. `generate_image`, `editImage`, `upscaleImage` and `variateImage` now read the image at a provider's URL through AgentOS's untrusted image read (public addresses only, 50 MiB, 30 seconds) and save it like image data: a file in the images directory, or the host's `saveImage`. The result carries the saved copy's URL.
- When that image cannot be read or saved, the provider's URL is returned as before, and a new `notes` field in the result says why.
- image-editing: the inputs a provider does not take are named in the tools' input descriptions, which a model reads, and not only in SKILL.md: `strength` and `negativePrompt` (not OpenAI), `size` (OpenAI only), `count` (Stability makes one image a call).
- vision-pipeline carries the same `imageFiles.ts`; nothing it does changes.
