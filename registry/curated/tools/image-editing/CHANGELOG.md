# @framers/agentos-ext-image-editing

## 0.2.0

### Minor Changes

- [#97](https://github.com/framerslab/agentos-extensions/pull/97) [`c718527`](https://github.com/framerslab/agentos-extensions/commit/c7185279c78ebff1060624dfe18285ecf407941b) Thanks [@jddunn](https://github.com/jddunn)! - The tools work. 0.1.0 shipped only `manifest.json`, so neither package could be imported, and every tool threw. editImage (img2img, inpaint with `maskUrl`, outpaint, style transfer with `styleImageUrl`), upscaleImage and variateImage now call AgentOS's `editImage`, `transferStyle`, `upscaleImage` and `variateImage`, with the provider named or the first one with a key. vision-pipeline runs an AgentOS `VisionPipeline` for `ocr`, `handwriting`, `layout`, `describe`, `embed` or `auto`, limited to `maxTier`. Image inputs are http(s) or data:image URLs: the tools read no local file. vision-pipeline drops the `language` input, which the pipeline has no setting for.

### Patch Changes

- [#101](https://github.com/framerslab/agentos-extensions/pull/101) [`b915381`](https://github.com/framerslab/agentos-extensions/commit/b9153818afc2afbe751b45f80677856ede999ce9) Thanks [@jddunn](https://github.com/jddunn)! - Image editing and vision refuse image URLs on this machine or a private network (localhost, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT ranges, their IPv6 forms) and send the trimmed source they checked. Vision decodes a percent-encoded data URL byte by byte without throwing, logs a pipeline that fails to release, and gives the cloud tier the OpenAI key from its options or secrets; style transfer gets the chosen provider's key. Both keys take effect from `@framers/agentos` 0.12.14. The Google Cloud speech packs read a credentials value as an inline key only when it opens like a JSON object, so a key file path such as `{keys}/sa.json` loads again.
