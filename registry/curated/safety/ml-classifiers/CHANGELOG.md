# @framers/agentos-ext-ml-classifiers

Releases after 0.2.1 are published from manicinc/voice-chat-assistant, the repository npm's newest version names; this copy is never released, so https://github.com/framerslab/agentos-extensions/releases holds none of them.

## 0.2.1

### Patch Changes

- [`15065c9`](https://github.com/framerslab/agentos-extensions/commit/15065c949ea5d25f4408ffab2079ad3e600ddded) Thanks [@jddunn](https://github.com/jddunn)! - Fix npm publish: add missing repository.url field for sigstore provenance verification

## 0.2.0

### Minor Changes

- [`c35afe8`](https://github.com/framerslab/agentos-extensions/commit/c35afe8c16fdf51df6ce2d0bb83de6cd702e3a8b) Thanks [@jddunn](https://github.com/jddunn)! - Implement all 5 guardrail extension packs with full detection logic:
  - PII Redaction: 4-tier detection (regex + keyword + NER + LLM)
  - Code Safety: OWASP regex patterns for SQL injection, XSS, command injection
  - ML Classifiers: toxicity/injection/NSFW via ONNX or LLM fallback
  - Topicality: embedding-based topic enforcement with LLM fallback
  - Grounding Guard: NLI-based hallucination detection against RAG sources
