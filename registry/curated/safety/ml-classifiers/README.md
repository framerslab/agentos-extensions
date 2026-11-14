# @framers/agentos-ext-ml-classifiers

This folder holds a copy of the package's source that is older than the published package: it has no `/moderation` entry point. It is not published from this repository ([RELEASING.md](../../../../RELEASING.md#foreign-names-and-private-packages), "Foreign names and private packages"): npm receives the package from another repository until [issue 121](https://github.com/framerslab/agentos-extensions/issues/121) moves its release here. Do not edit the source here.

The published package and its README are on npm: [@framers/agentos-ext-ml-classifiers](https://www.npmjs.com/package/@framers/agentos-ext-ml-classifiers). It holds a content classifier guardrail (one local English toxicity model, `toxic-bert` through ONNX, with an LLM judge or keyword patterns when that model is not available) and a second entry point, `@framers/agentos-ext-ml-classifiers/moderation`, with an OpenAI Moderation guard and a conduct classifier on a judge model you choose. The `/moderation` entry point needs `@framers/agentos` 0.17.1 or newer.

See the [two-tier extension pattern](../../../../README.md#two-tier-extension-pattern) in the main README.
