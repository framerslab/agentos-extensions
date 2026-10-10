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
**vision-pipeline** takes `imageUrl`, `mode` and `maxTier`. `imageUrl` is a `data:image/...` URL or an http(s) URL on a public host: local file paths and addresses on this machine or a private network are refused, so a model cannot send the machine's files, or what its network serves, to a cloud model. With AgentOS 0.13.16 or later, the tool fetches an http(s) image through `imageToBuffer`'s untrusted mode and hands the pipeline the bytes: every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the fetch stops at 50 MiB and 30 seconds. With an older AgentOS the check reads the URL's host as written, so the address a public name resolves to and a redirect's target are not checked.

| mode | what it returns | lowest maxTier |
|------|-----------------|----------------|
| `auto` (default) | the pipeline's best text | 1 |
| `ocr` | printed text | 1 |
| `handwriting` | handwritten text (TrOCR) | 2 |
| `layout` | the lines of text, each with its box, in `layout` (Florence-2) | 2 |
| `embed` | a CLIP embedding vector | 2 |
| `describe` | what the image shows (cloud vision) | 3 |

`maxTier` 1 runs local OCR alone, 2 adds the local vision models, 3 (default) may use cloud vision.

A text result (every mode but `embed`) names the tiers that ran in `tiers`. A tier that was due to run and failed, such as a model that did not load, is listed in `failedTiers` with its error, and the text comes from the tiers that ran. `embed` returns the vector in `embedding` with its `dimensions`, or the error when the embedding tier cannot run.

The handwriting, layout and embedding tiers run with `@framers/agentos` 0.13.30 or later, and the OCR tiers with 0.13.32 or later. Earlier releases load models transformers.js cannot run and read result shapes ppu-paddle-ocr 6 and tesseract.js 7 do not return, so those tiers fail or come back empty.

## Setup
The local tiers use the optional packages AgentOS finds installed: `ppu-paddle-ocr` or `tesseract.js` for OCR, and `@huggingface/transformers` for handwriting, layout and embeddings. With an OpenAI key in the pack option `openaiApiKey` or the secret `openai.apiKey`, the cloud tier uses OpenAI with that key. Without one, it uses the first provider whose key is in the environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `OPENROUTER_API_KEY`. `describe` and the cloud tier need `@framers/agentos` 0.12.14 or later: earlier releases send the image to the cloud model as text, and read the key from the environment only.

## Example
"Read the text from this receipt"
"What does this handwritten note say?"
"List the lines of this scanned page with where each one sits"
