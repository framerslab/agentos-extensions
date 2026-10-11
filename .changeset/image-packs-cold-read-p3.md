---
'@framers/agentos-ext-image-editing': minor
'@framers/agentos-ext-vision-pipeline': minor
---

Fixes from a cold read of the image packs.

- **Breaking: image-editing offers no `style-transfer`.** AgentOS's `transferStyle` sends no provider both images: with a provider named, which the tool does whenever it holds a key, it ran an img2img of the source by the prompt and dropped the style image; its Flux Redux route on Replicate made a variation of the style image and dropped the source. The mode, and a `styleImageUrl`, are refused with that reason; describe the style in the prompt with `img2img`.
- image-editing: a `maskUrl` given with no `mode` means `inpaint`; one given with `img2img`, which would have been dropped, is refused. SKILL.md says which options each provider takes (OpenAI: no `strength` or `negativePrompt`; Stability: no `size`, one image a call; Replicate: no `size`).
- vision-pipeline: a read in which no tier ran fails, instead of succeeding with empty text. The error gives each tier that failed with its error, or, when none could run (no OCR engine, no local models, no cloud key within maxTier), what would let one of that call's tiers run: for `ocr` an OCR engine, for `describe` a cloud key. SKILL.md says that TrOCR reads one line of handwriting.
