# @framers/agentos-ext-image-editing

## 0.3.0

### Minor Changes

- [#131](https://github.com/framerslab/agentos-extensions/pull/131) [`ec23af5`](https://github.com/framerslab/agentos-extensions/commit/ec23af533147e21d2ab10b01b6bc3128120b4768) Thanks [@jddunn](https://github.com/jddunn)! - The image-editing tools save the image data a provider returns and give back a short URL, never a `data:` URL. OpenAI's GPT Image models and Stability answer with image data, and as a `data:` URL that data went into the model's next request: megabytes of base64.
  
  - **Breaking: no `data:` URL in a result.** Image data is written to a file in the images directory (the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory), each caller in a subdirectory of its own, and the result carries the `file:` URL. A host whose clients are elsewhere passes `saveImage`, which stores the bytes and returns the http(s) URL its clients load. A provider's own URL is returned as before.
  - A `file:` URL the tools returned is accepted as a source, for the caller it was saved for. Every other local file stays refused.
  - **Breaking: `@framers/agentos` 0.13.40 or later.** An http(s) image is fetched only through AgentOS's untrusted fetch. With an older AgentOS the tools handed it the URL, and it fetched without checking the address a name resolves to or the target of a redirect.
  - A `model` with another provider's prefix (`replicate:owner/name` on a call that uses the OpenAI key) is refused: AgentOS let the prefix choose the provider and sent it the other provider's key.
  - Arguments the schema does not allow are refused before anything is fetched or sent: an unknown `mode`, a `scale` other than 2 or 4, a `count` or `strength` that is no number, a `model`, `size` or `negativePrompt` that is no string.
  - **Breaking: `outpaint` is gone.** No provider route extends an image; the mode ran as img2img and returned the same canvas.
  - `upscaleImage` asks Replicate first under `auto`, whose upscaler takes the factor. Stability's returns four times the input whatever is asked: a call that asks it for 2 is refused, and the result carries the `scale` applied.
  - IPv6 outside `2000::/3`, the one block allocated for global unicast, is not a public host.

### Patch Changes

- [#133](https://github.com/framerslab/agentos-extensions/pull/133) [`d810f4a`](https://github.com/framerslab/agentos-extensions/commit/d810f4a5b7a5fe0e0bd04ab582efde540c83bb5b) Thanks [@jddunn](https://github.com/jddunn)! - Follow-ups from review of the saved images.
  
  - A saved image is read only from the caller's own directory under the images directory's real path. A caller's directory that is a link to another caller's is refused, to read from and to save in, and so is an images directory that has been swapped for one this user does not own.
  - The packs save and read under an images directory only when no other user can change a directory above it: each one belongs to this user or to root and is writable by no one else unless it is sticky, as `/tmp` is.
  - vision-pipeline: `maxTier: null` is refused, like any value the schema does not allow; only an absent `maxTier` means tier 3. The exported `imageInput` refuses a `file:` URL, as it did before the tool learned to read saved images; the tool still reads them.
  - image-generation: a `size` outside the schema's list is refused before any provider call.

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

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
