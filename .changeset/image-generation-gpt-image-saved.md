---
'@framers/agentos-ext-image-generation': major
---

`generate_image` works with OpenAI again, and saves the image data a provider returns instead of handing it to the model.

- The OpenAI default model is `gpt-image-2.5-flare`. It was `dall-e-3`, which OpenAI shut down on 2026-05-12, so every OpenAI call that named no model failed. `quality` takes `low`, `medium`, `high` and `auto`; `standard` and `hd` are sent to a GPT Image model as `medium` and `high`. A GPT Image model takes no `style` parameter, so a `style` the call gives goes into the prompt.
- **Breaking: no `data:` URL in a result.** OpenAI's GPT Image models and Stability answer with image data, and as a `data:` URL that data went into the model's next request: megabytes of base64. The data is written to a file in the images directory (the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory), each caller in a subdirectory of its own, and the result carries the `file:` URL, which the image-editing and vision-pipeline tools accept as a source. A host whose clients are elsewhere passes `saveImage`, which stores the bytes and returns the http(s) URL its clients load. A provider's own URL is returned as before.
- The tool passes on the fields of its schema and nothing else. `n` and `providerOptions` in a tool call's arguments, which the schema never had, reached the provider: `providerOptions.*.extraBody` went into its request body. `ImageGenerationService.generateImage`, which a host calls from code, keeps both.
- Arguments the schema does not allow are refused before any provider is called.
- The pack reports its package's version; it reported `1.0.0`.
