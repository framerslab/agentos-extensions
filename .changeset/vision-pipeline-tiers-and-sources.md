---
'@framers/agentos-ext-vision-pipeline': minor
---

The vision-pipeline tool runs the tier a mode is named for, takes a saved image as a source, and stops acting on arguments its schema does not allow.

- `handwriting` and `layout` name their tier (TrOCR, Florence-2). With the category alone, a pipeline that may reach the cloud returned plain OCR text as soon as OCR was confident, and a tier whose model was not installed was passed over without a word. **Breaking:** such a call now fails with the reason.
- No text call runs a CLIP embedding. The pipelines were built with the embedding tier on, so every text call ran one, waited for it and dropped the vector; the first downloaded a 350 MB model. `embed` loads CLIP when it is first asked for.
- `imageUrl` accepts the `file:` URL of an image the image-generation or image-editing tools saved, for the caller it was saved for. The images directory is the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory. Every other local file stays refused.
- **Breaking: `@framers/agentos` 0.13.40 or later.** An http(s) image is fetched only through AgentOS's untrusted fetch. With an older AgentOS the tool handed it the URL, and it fetched without checking the address a name resolves to or the target of a redirect.
- A `maxTier` the schema does not allow (`"cloud"`, `0`, `2.5`) is refused. It was read as 3, the tier that sends the image to a cloud model.
- IPv6 outside `2000::/3`, the one block allocated for global unicast, is not a public host.
