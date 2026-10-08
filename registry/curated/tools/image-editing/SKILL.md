---
name: image-editing
description: Edit, transform, and enhance images using AI models
version: 1.0.0
tags: [image, editing, img2img, inpainting, upscaling, variation]
tools_required: [editImage, upscaleImage, variateImage]
---

# Image Editing

Edit images with img2img transformation, inpainting (fill masked regions), outpainting (extend beyond borders), style transfer, upscaling (2x/4x super resolution), and variations.

## Tools
- **editImage**: `imageUrl` and `prompt`; `mode` is `img2img` (default), `inpaint` (with `maskUrl`, white = repaint), `outpaint`, or `style-transfer` (with `styleImageUrl`). Optional `strength` (0 to 1), `size`, `negativePrompt`, `model`.
- **upscaleImage**: `imageUrl`; `scale` 2 (default) or 4.
- **variateImage**: `imageUrl`; `count` 1 to 4.

Every image input is an http(s) URL or a `data:image/...` URL. The tools refuse local file paths, so a model cannot send the machine's files to an image provider. Results are URLs, or data URLs when the provider returns image data.

## Providers
OpenAI, Stability AI and Replicate, chosen by `provider` or, with `auto`, the first one with a key (`OPENAI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`, or the secrets `openai.apiKey`, `stability.apiKey`, `replicate.apiToken`). With no key set, AgentOS chooses a provider from the environment, as its `editImage` does when called without one. Style transfer reads its provider's key from the environment.

## Example
"Take this photo and make it look like a watercolor painting"
"Remove the car from this street photo" (inpaint, with a mask)
"Upscale this image to 4x resolution"
