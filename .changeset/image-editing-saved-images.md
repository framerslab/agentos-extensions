---
'@framers/agentos-ext-image-editing': minor
---

The image-editing tools save the image data a provider returns and give back a short URL, never a `data:` URL. OpenAI's GPT Image models and Stability answer with image data, and as a `data:` URL that data went into the model's next request: megabytes of base64.

- **Breaking: no `data:` URL in a result.** Image data is written to a file in the images directory (the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory), each caller in a subdirectory of its own, and the result carries the `file:` URL. A host whose clients are elsewhere passes `saveImage`, which stores the bytes and returns the http(s) URL its clients load. A provider's own URL is returned as before.
- A `file:` URL the tools returned is accepted as a source, for the caller it was saved for. Every other local file stays refused.
- **Breaking: `@framers/agentos` 0.13.40 or later.** An http(s) image is fetched only through AgentOS's untrusted fetch. With an older AgentOS the tools handed it the URL, and it fetched without checking the address a name resolves to or the target of a redirect.
- A `model` with another provider's prefix (`replicate:owner/name` on a call that uses the OpenAI key) is refused: AgentOS let the prefix choose the provider and sent it the other provider's key.
- Arguments the schema does not allow are refused before anything is fetched or sent: an unknown `mode`, a `scale` other than 2 or 4, a `count` or `strength` that is no number, a `model`, `size` or `negativePrompt` that is no string.
- **Breaking: `outpaint` is gone.** No provider route extends an image; the mode ran as img2img and returned the same canvas.
- `upscaleImage` asks Replicate first under `auto`, whose upscaler takes the factor. Stability's returns four times the input whatever is asked: a call that asks it for 2 is refused, and the result carries the `scale` applied.
- IPv6 outside `2000::/3`, the one block allocated for global unicast, is not a public host.
