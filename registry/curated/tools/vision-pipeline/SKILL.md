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
**vision-pipeline** takes `imageUrl`, `mode` and `maxTier`. `imageUrl` is a `data:image/...` URL or an http(s) URL on a public host: local file paths and addresses on this machine or a private network are refused, so a model cannot send the machine's files, or what its network serves, to a cloud model.

| mode | what it returns | lowest maxTier |
|------|-----------------|----------------|
| `auto` (default) | the pipeline's best text | 1 |
| `ocr` | printed text | 1 |
| `handwriting` | handwritten text (TrOCR) | 2 |
| `layout` | document text and structure (Florence-2) | 2 |
| `embed` | a CLIP embedding vector | 2 |
| `describe` | what the image shows (cloud vision) | 3 |

`maxTier` 1 runs local OCR alone, 2 adds the local vision models, 3 (default) may use cloud vision.

## Setup
The local tiers use the optional packages AgentOS finds installed: `ppu-paddle-ocr` or `tesseract.js` for OCR, and `@huggingface/transformers` for handwriting, layout and embeddings. With an OpenAI key in the pack option `openaiApiKey` or the secret `openai.apiKey`, the cloud tier uses OpenAI with that key. Without one, it uses the first provider whose key is in the environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (or `GEMINI_API_KEY`), `OPENROUTER_API_KEY`. `describe` and the cloud tier need `@framers/agentos` 0.12.14 or later: earlier releases send the image to the cloud model as text, and read the key from the environment only.

## Example
"Read the text from this receipt"
"What does this handwritten note say?"
"Extract the table data from this PDF page"
