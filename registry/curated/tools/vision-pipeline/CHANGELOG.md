# @framers/agentos-ext-vision-pipeline

## 0.3.0

### Minor Changes

- [#132](https://github.com/framerslab/agentos-extensions/pull/132) [`8c3f890`](https://github.com/framerslab/agentos-extensions/commit/8c3f89084afe3467cda23cc6b20db209482724d0) Thanks [@jddunn](https://github.com/jddunn)! - The vision-pipeline tool runs the tier a mode is named for, takes a saved image as a source, and stops acting on arguments its schema does not allow.
  
  - `handwriting` and `layout` name their tier (TrOCR, Florence-2). With the category alone, a pipeline that may reach the cloud returned plain OCR text as soon as OCR was confident, and a tier whose model was not installed was passed over without a word. **Breaking:** such a call now fails with the reason.
  - No text call runs a CLIP embedding. The pipelines were built with the embedding tier on, so every text call ran one, waited for it and dropped the vector; the first downloaded a 350 MB model. `embed` loads CLIP when it is first asked for.
  - `imageUrl` accepts the `file:` URL of an image the image-generation or image-editing tools saved, for the caller it was saved for. The images directory is the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory. Every other local file stays refused.
  - **Breaking: `@framers/agentos` 0.13.40 or later.** An http(s) image is fetched only through AgentOS's untrusted fetch. With an older AgentOS the tool handed it the URL, and it fetched without checking the address a name resolves to or the target of a redirect.
  - A `maxTier` the schema does not allow (`"cloud"`, `0`, `2.5`) is refused. It was read as 3, the tier that sends the image to a cloud model.
  - IPv6 outside `2000::/3`, the one block allocated for global unicast, is not a public host.

### Patch Changes

- [#133](https://github.com/framerslab/agentos-extensions/pull/133) [`d810f4a`](https://github.com/framerslab/agentos-extensions/commit/d810f4a5b7a5fe0e0bd04ab582efde540c83bb5b) Thanks [@jddunn](https://github.com/jddunn)! - Follow-ups from review of the saved images.
  
  - A saved image is read only from the caller's own directory under the images directory's real path. A caller's directory that is a link to another caller's is refused, to read from and to save in, and so is an images directory that has been swapped for one this user does not own.
  - The packs save and read under an images directory only when no other user can change a directory above it: each one belongs to this user or to root and is writable by no one else unless it is sticky, as `/tmp` is.
  - vision-pipeline: `maxTier: null` is refused, like any value the schema does not allow; only an absent `maxTier` means tier 3. The exported `imageInput` refuses a `file:` URL, as it did before the tool learned to read saved images; the tool still reads them.
  - image-generation: a `size` outside the schema's list is refused before any provider call.

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.2.3

### Patch Changes

- [#115](https://github.com/framerslab/agentos-extensions/pull/115) [`0bcf4aa`](https://github.com/framerslab/agentos-extensions/commit/0bcf4aae489db657225b826a9a7826d69072de36) Thanks [@jddunn](https://github.com/jddunn)! - The vision-pipeline tool reads a data URL as AgentOS's `imageToBuffer` does: it drops tabs and line breaks first, and decodes base64 when `;base64`, with spaces around it allowed, ends the media type. `data:image/png; base64,...`, `data:image/png;base64 ,...` and their tab and line-break spellings reached the pipeline as the bytes of their base64 text. The tool also returns the pipeline's `layout`, a text block per line with its box, and `failedTiers`, each tier that was due to run and failed with its error. SKILL.md names the AgentOS releases whose local tiers run: 0.13.30 for handwriting, layout and embeddings, 0.13.32 for OCR.

## 0.2.2

### Patch Changes

- [#114](https://github.com/framerslab/agentos-extensions/pull/114) [`d09a91a`](https://github.com/framerslab/agentos-extensions/commit/d09a91a5880e916dd5fa1ad5bb6dd427f63018ed) Thanks [@jddunn](https://github.com/jddunn)! - The image-editing and vision-pipeline tools refuse image URLs on the blocks the IANA special-purpose registries mark not globally reachable that their host check missed: 192.88.99.0/24, 100::/63, 2001::/23, 3fff::/20 and 5f00::/16.

## 0.2.1

### Patch Changes

- [#105](https://github.com/framerslab/agentos-extensions/pull/105) [`98849f8`](https://github.com/framerslab/agentos-extensions/commit/98849f8dc41b94396460a00ae6c80e2f10472f68) Thanks [@jddunn](https://github.com/jddunn)! - The image-editing and vision-pipeline tools fetch an http(s) image through AgentOS's `imageToBuffer` with `untrusted: true` when the installed AgentOS has that mode (0.13.16 or later): every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the fetch stops at 50 MiB and 30 seconds. With an older AgentOS the URL goes to AgentOS as before, checked by its host as written.

## 0.2.0

### Minor Changes

- [#97](https://github.com/framerslab/agentos-extensions/pull/97) [`c718527`](https://github.com/framerslab/agentos-extensions/commit/c7185279c78ebff1060624dfe18285ecf407941b) Thanks [@jddunn](https://github.com/jddunn)! - The tools work. 0.1.0 shipped only `manifest.json`, so neither package could be imported, and every tool threw. editImage (img2img, inpaint with `maskUrl`, outpaint, style transfer with `styleImageUrl`), upscaleImage and variateImage now call AgentOS's `editImage`, `transferStyle`, `upscaleImage` and `variateImage`, with the provider named or the first one with a key. vision-pipeline runs an AgentOS `VisionPipeline` for `ocr`, `handwriting`, `layout`, `describe`, `embed` or `auto`, limited to `maxTier`. Image inputs are http(s) or data:image URLs: the tools read no local file. vision-pipeline drops the `language` input, which the pipeline has no setting for.

### Patch Changes

- [#101](https://github.com/framerslab/agentos-extensions/pull/101) [`b915381`](https://github.com/framerslab/agentos-extensions/commit/b9153818afc2afbe751b45f80677856ede999ce9) Thanks [@jddunn](https://github.com/jddunn)! - Image editing and vision refuse image URLs on this machine or a private network (localhost, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT ranges, their IPv6 forms) and send the trimmed source they checked. Vision decodes a percent-encoded data URL byte by byte without throwing, logs a pipeline that fails to release, and gives the cloud tier the OpenAI key from its options or secrets; style transfer gets the chosen provider's key. Both keys take effect from `@framers/agentos` 0.12.14. The Google Cloud speech packs read a credentials value as an inline key only when it opens like a JSON object, so a key file path such as `{keys}/sa.json` loads again.
