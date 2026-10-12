# @framers/agentos-ext-image-editing

## 0.6.1

### Patch Changes

- [#173](https://github.com/framerslab/agentos-extensions/pull/173) [`9275c36`](https://github.com/framerslab/agentos-extensions/commit/9275c36361eb1c9f3c10b504757d9815b33ad050) Thanks [@jddunn](https://github.com/jddunn)! - The README and the manifest describe `editImage`'s style transfer: the `style-transfer` mode, `styleImageUrl`, what `strength` does there on each provider, and the AgentOS release it needs. They said style transfer fails.

## 0.6.0

### Minor Changes

- [#169](https://github.com/framerslab/agentos-extensions/pull/169) [`ad91d6d`](https://github.com/framerslab/agentos-extensions/commit/ad91d6de950d3f8d9c177c1226b6d8337b53887c) Thanks [@jddunn](https://github.com/jddunn)! - `editImage` offers style transfer: `mode: 'style-transfer'` with a `styleImageUrl`, the image whose style is applied, while `imageUrl` keeps its subject and composition. A `styleImageUrl` given with no mode asks for it, and one given with another mode is refused, as a `maskUrl` is. The call goes through AgentOS's `transferStyle`, which from 0.13.59 sends the provider both images (Stability on its style-transfer endpoint, OpenAI as two `image[]` parts, Replicate on FLUX.2). On an older AgentOS, which sent one of the two, style transfer is refused with the release it needs, and the other modes run as before.

## 0.5.0

### Minor Changes

- [#149](https://github.com/framerslab/agentos-extensions/pull/149) [`fa5b48d`](https://github.com/framerslab/agentos-extensions/commit/fa5b48dfcff98624f80c70da17386d99fff0779a) Thanks [@jddunn](https://github.com/jddunn)! - An image a provider leaves at a URL of its own is saved too, so the reference in the result keeps working.
  
  - The image tools saved the image data OpenAI and Stability answer with, and passed Replicate's URL on as it was. Replicate deletes an API prediction's output files after an hour (https://replicate.com/docs/topics/predictions/output-files), so an hour later the image in the conversation was gone and the URL could not be the source of a later edit. `generate_image`, `editImage`, `upscaleImage` and `variateImage` now read the image at a provider's URL through AgentOS's untrusted image read (public addresses only, 50 MiB, 30 seconds) and save it like image data: a file in the images directory, or the host's `saveImage`. The result carries the saved copy's URL.
  - When that image cannot be read or saved, the provider's URL is returned as before, and a new `notes` field in the result says why.
  - image-editing: the inputs a provider does not take are named in the tools' input descriptions, which a model reads, and not only in SKILL.md: `strength` and `negativePrompt` (not OpenAI), `size` (OpenAI only), `count` (Stability makes one image a call).
  - vision-pipeline carries the same `imageFiles.ts`; nothing it does changes.

## 0.4.0

### Minor Changes

- [#140](https://github.com/framerslab/agentos-extensions/pull/140) [`b701049`](https://github.com/framerslab/agentos-extensions/commit/b70104970d56905e09f9cd8eb01c648faf9f6c7f) Thanks [@jddunn](https://github.com/jddunn)! - Fixes from a cold read of the image packs.
  
  - **Breaking: image-editing offers no `style-transfer`.** AgentOS's `transferStyle` sends no provider both images: with a provider named, which the tool does whenever it holds a key, it ran an img2img of the source by the prompt and dropped the style image; its Flux Redux route on Replicate made a variation of the style image and dropped the source. The mode, and a `styleImageUrl`, are refused with that reason; describe the style in the prompt with `img2img`.
  - image-editing: a `maskUrl` given with no `mode` means `inpaint`; one given with `img2img`, which would have been dropped, is refused. SKILL.md says which options each provider takes (OpenAI: no `strength` or `negativePrompt`; Stability: no `size`, one image a call; Replicate: no `size`).
  - vision-pipeline: a read in which no tier ran fails, instead of succeeding with empty text. The error gives each tier that failed with its error, or, when none could run (no OCR engine, no local models, no cloud key within maxTier), what would let one of that call's tiers run: for `ocr` an OCR engine, for `describe` a cloud key. SKILL.md says that TrOCR reads one line of handwriting.

### Patch Changes

- [#135](https://github.com/framerslab/agentos-extensions/pull/135) [`565e503`](https://github.com/framerslab/agentos-extensions/commit/565e503ce1a6892230891c0a02a1e9fdd9bfa166) Thanks [@jddunn](https://github.com/jddunn)! - The images directory is checked before a provider is asked for an image, and a refusal names what to change.
  
  - With no host `saveImage`, `generate_image`, `editImage`, `upscaleImage` and `variateImage` make and check the images directory and the caller's directory in it, write access included, before they call the provider. A provider bills for the image it makes; a directory the saver refused used to cost every call its result. Replicate is checked too: AgentOS asks it in sync mode, where it can answer with a `data:` URL that is saved like any other image data.
  - Every directory above the images directory must still belong to this user or root and be writable by no one else unless it is sticky: a user who could rename an entry there could swap the tree between a check and the write or read that follows it, and Node has no `openat` to pin a checked directory. The error now names that directory, its owner and its mode (for example, a disk-backed Kubernetes `emptyDir` at `/tmp`: owner uid 0, mode 0777, not sticky), and SKILL.md says how a pod's volume passes: made sticky (by an init container, or `emptyDir.mode: 01777` where the cluster has Kubernetes 1.37's alpha `EmptyDirVolumeMode` gate) or given to the service's user, or replaced by a host `saveImage`.
  - A saved image is read only from the caller's own directory, matched by device and inode and never a link, and every directory it is opened through must pass the same rule as those above the images directory; once the file is open the path is checked again to reach that file in that directory.

- [#153](https://github.com/framerslab/agentos-extensions/pull/153) [`ca5be51`](https://github.com/framerslab/agentos-extensions/commit/ca5be5157e296d730363027d40605f428fd04935) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

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
