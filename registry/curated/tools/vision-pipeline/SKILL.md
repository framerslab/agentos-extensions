---
name: vision-ocr
description: Extract text from images using OCR and vision AI
version: 1.0.0
tags: [vision, ocr, text-extraction, document, handwriting]
tools_required: [vision-pipeline]
---

# Vision & OCR

Extract text from images, documents, and handwritten notes with a progressive 3-tier pipeline: local OCR (PaddleOCR or Tesseract), then local vision models (TrOCR, Florence-2), then cloud vision.

## Tool
**vision-pipeline** takes `imageUrl`, `mode` and `maxTier`. `imageUrl` is one of:
- an http(s) URL on a public host;
- a `data:image/...` URL;
- the `file:` URL of an image the image-generation or image-editing tools saved, for the caller it was saved for.

Every other local file is refused, and so are addresses on this machine or a private network (for IPv6, everything outside `2000::/3`), so a model cannot send the machine's files, or what its network serves, to a cloud model. An http(s) image is fetched through AgentOS's `imageToBuffer` in its untrusted mode, and the pipeline gets the bytes: every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the image is held to 50 MiB and 30 seconds.

| mode | what it returns | lowest maxTier |
|------|-----------------|----------------|
| `auto` (default) | the pipeline's best text | 1 |
| `ocr` | printed text | 1 |
| `handwriting` | handwritten text (TrOCR) | 2 |
| `layout` | the lines of text, each with its box, in `layout` (Florence-2) | 2 |
| `embed` | a CLIP embedding vector | 2 |
| `describe` | what the image shows (cloud vision) | 3 |

`maxTier` 1 runs local OCR alone, 2 adds the local vision models, 3 (default) may use cloud vision. Any other value is refused: it is not read as 3.

`handwriting` and `layout` run the tier they are named for and nothing else. When its model is not installed the call fails with the reason; it does not come back with plain OCR text. `auto` lets the pipeline choose, and returns as soon as a tier is confident.

A text result (every mode but `embed`) names the tiers that ran in `tiers`. A tier that was due to run and failed, such as a model that did not load, is listed in `failedTiers` with its error, and the text comes from the tiers that ran. `embed` returns the vector in `embedding` with its `dimensions`, or the error when the embedding tier cannot run.

CLIP is loaded for `embed` alone, the first time it is asked for: no text call runs an embedding.

Requires `@framers/agentos` 0.13.40 or later.

## Setup
The local tiers use the optional packages AgentOS finds installed: `ppu-paddle-ocr` or `tesseract.js` for OCR, and `@huggingface/transformers` for handwriting, layout and embeddings. With an OpenAI key in the pack option `openaiApiKey` or the secret `openai.apiKey`, the cloud tier uses OpenAI with that key. Without one, it uses the first provider whose key is in the environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `OPENROUTER_API_KEY`.

The images directory, for `file:` sources, is the pack option `imageDir`, else the environment variable `AGENTOS_IMAGE_DIR`, else `agentos-images-<uid>` in the temp directory: the same as the image-generation and image-editing packs'. Give all three the same `imageDir`.

## Example
"Read the text from this receipt"
"What does this handwritten note say?"
"List the lines of this scanned page with where each one sits"
