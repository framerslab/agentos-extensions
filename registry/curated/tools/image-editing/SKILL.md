---
name: image-editing
description: Edit, transform, and enhance images using AI models
version: 1.0.0
tags: [image, editing, img2img, inpainting, upscaling, variation]
tools_required: [editImage, upscaleImage, variateImage]
---

# Image Editing

Edit images with img2img transformation, inpainting (fill masked regions), style transfer, upscaling and variations.

## Tools
- **editImage**: `imageUrl` and `prompt`; `mode` is `img2img` (default), `inpaint` (with `maskUrl`, white = repaint), or `style-transfer` (with `styleImageUrl`). Optional `strength` (0 to 1), `size`, `negativePrompt`, `model`.
- **upscaleImage**: `imageUrl`; `scale` 2 or 4. Replicate takes the factor (default 2). Stability's upscaler returns four times the input whatever is asked and takes an input of at most 1,048,576 pixels, so a call that asks it for 2 is refused. The result carries the `scale` that was applied.
- **variateImage**: `imageUrl`; `count` 1 to 4.

`model` is the provider's own id without a provider prefix; a prefix that names another provider is refused. An argument the schema does not allow is refused before anything is fetched or sent.

## Image inputs
Every image input is one of:
- an http(s) URL on a public host;
- a `data:image/...` URL;
- the `file:` URL of an image one of these tools saved (see Results).

The tools refuse every other local file, and addresses on this machine or a private network (`localhost`, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT IPv4 ranges, and for IPv6 everything outside `2000::/3`), so a model cannot send the machine's files, or what its network serves, to an image provider. An http(s) image is fetched through AgentOS's `imageToBuffer` in its untrusted mode: every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the image is held to 50 MiB and 30 seconds.

## Results
A provider's own image URL is returned as it is. Image data is saved, and the result carries the URL of the saved copy: OpenAI's GPT Image models and Stability answer with data, not a URL. Image data is never returned itself: as a `data:` URL it would go into the model's next request, megabytes of base64.

- By default the copy is a file and the result is its `file:` URL. The images directory is the pack option `imageDir`, else the environment variable `AGENTOS_IMAGE_DIR`, else `agentos-images-<uid>` in the temp directory (on Windows, `AppData\Local\Temp\agentos-images` in the user's profile). Each caller (`userContext.userId`) has a subdirectory of its own, and a saved image is a source only for the caller it was saved for.
- The directory must belong to the service's user, with no one else able to write it. Every directory above it must belong to that user or to root and be writable by no one else, unless it is sticky as `/tmp` is: another user who could rename one of them could swap the images directory for one of their own. The tools refuse to save or read otherwise, and the error names the directory.
- The image-generation and vision-pipeline packs use the same directory, so an image one of them saved is a source for the others. Give all three the same `imageDir`, or set `AGENTOS_IMAGE_DIR`.
- The packs delete nothing. The host clears the directory; the operating system clears the default one.
- A `file:` URL names a file on the machine that ran the tool. A host whose clients are elsewhere passes `saveImage` in the pack options: a function that stores the bytes and returns the http(s) URL its clients load.

## Providers
OpenAI, Stability AI and Replicate, chosen by `provider` or, with `auto`, the first one with a key (`OPENAI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`, or the secrets `openai.apiKey`, `stability.apiKey`, `replicate.apiToken`); `upscaleImage` asks Replicate first. With no key set, AgentOS chooses a provider from the environment, as its `editImage` does when called without one.

Requires `@framers/agentos` 0.13.40 or later.

## Example
"Take this photo and make it look like a watercolor painting"
"Remove the car from this street photo" (inpaint, with a mask)
"Upscale this image to 4x resolution"
