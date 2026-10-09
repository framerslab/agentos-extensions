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

Every image input is a `data:image/...` URL or an http(s) URL on a public host. The tools refuse local file paths and addresses on this machine or a private network (`localhost`, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT IPv4 ranges, and their IPv6 forms), so a model cannot send the machine's files, or what its network serves, to an image provider. With an AgentOS whose `imageToBuffer` has the untrusted mode (it exports `isPublicNetworkAddress`), the tools fetch an http(s) image through that mode: every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the fetch stops at 50 MiB and 30 seconds. With an older AgentOS the check reads the URL's host as written, so the address a public name resolves to and the target of a redirect are not checked. Results are URLs, or data URLs when the provider returns image data.

## Providers
OpenAI, Stability AI and Replicate, chosen by `provider` or, with `auto`, the first one with a key (`OPENAI_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`, or the secrets `openai.apiKey`, `stability.apiKey`, `replicate.apiToken`). With no key set, AgentOS chooses a provider from the environment, as its `editImage` does when called without one. Style transfer passes the chosen provider's key to AgentOS from `@framers/agentos` 0.12.14; earlier releases read the key from the environment.

## Example
"Take this photo and make it look like a watercolor painting"
"Remove the car from this street photo" (inpaint, with a mask)
"Upscale this image to 4x resolution"
