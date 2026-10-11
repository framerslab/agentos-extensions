# @framers/agentos-ext-image-generation

## 2.0.0

### Major Changes

- [#130](https://github.com/framerslab/agentos-extensions/pull/130) [`a0b853c`](https://github.com/framerslab/agentos-extensions/commit/a0b853c025aa0b5e2374ac5b87b984025074a47c) Thanks [@jddunn](https://github.com/jddunn)! - `generate_image` works with OpenAI again, and saves the image data a provider returns instead of handing it to the model.
  
  - The OpenAI default model is `gpt-image-2.5-flare`. It was `dall-e-3`, which OpenAI shut down on 2026-05-12, so every OpenAI call that named no model failed. `quality` takes `low`, `medium`, `high` and `auto`; `standard` and `hd` are sent to a GPT Image model as `medium` and `high`. A GPT Image model takes no `style` parameter, so a `style` the call gives goes into the prompt.
  - **Breaking: no `data:` URL in a result.** OpenAI's GPT Image models and Stability answer with image data, and as a `data:` URL that data went into the model's next request: megabytes of base64. The data is written to a file in the images directory (the pack option `imageDir`, else `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory), each caller in a subdirectory of its own, and the result carries the `file:` URL, which the image-editing and vision-pipeline tools accept as a source. A host whose clients are elsewhere passes `saveImage`, which stores the bytes and returns the http(s) URL its clients load. A provider's own URL is returned as before.
  - The tool passes on the fields of its schema and nothing else. `n` and `providerOptions` in a tool call's arguments, which the schema never had, reached the provider: `providerOptions.*.extraBody` went into its request body. `ImageGenerationService.generateImage`, which a host calls from code, keeps both.
  - Arguments the schema does not allow are refused before any provider is called.
  - The pack reports its package's version; it reported `1.0.0`.

### Patch Changes

- [#133](https://github.com/framerslab/agentos-extensions/pull/133) [`d810f4a`](https://github.com/framerslab/agentos-extensions/commit/d810f4a5b7a5fe0e0bd04ab582efde540c83bb5b) Thanks [@jddunn](https://github.com/jddunn)! - Follow-ups from review of the saved images.
  
  - A saved image is read only from the caller's own directory under the images directory's real path. A caller's directory that is a link to another caller's is refused, to read from and to save in, and so is an images directory that has been swapped for one this user does not own.
  - The packs save and read under an images directory only when no other user can change a directory above it: each one belongs to this user or to root and is writable by no one else unless it is sticky, as `/tmp` is.
  - vision-pipeline: `maxTier: null` is refused, like any value the schema does not allow; only an absent `maxTier` means tier 3. The exported `imageInput` refuses a `file:` URL, as it did before the tool learned to read saved images; the tool still reads them.
  - image-generation: a `size` outside the schema's list is refused before any provider call.

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 1.1.0

### Minor Changes

- [#78](https://github.com/framerslab/agentos-extensions/pull/78) [`d9561f1`](https://github.com/framerslab/agentos-extensions/commit/d9561f17043bb4953732d9599fe0a2a7c387394d) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 1.0.3

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

## 1.0.2

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
