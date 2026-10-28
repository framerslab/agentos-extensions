# @framers/agentos-ext-voice-twilio

Releases after 0.2.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-voice-twilio@<version>`.

## 0.2.0

### Minor Changes

- [#219](https://github.com/framerslab/agentos-extensions/pull/219) [`f074690`](https://github.com/framerslab/agentos-extensions/commit/f0746905700b9e87a8178f093edf355f264df762) Thanks [@jddunn](https://github.com/jddunn)! - Emit the core speech events alongside the retained legacy events, drain Whisper requests before the final transcript, preserve sentence ordering during synthesis, and decode ElevenLabs JSON audio. Expose the call manager binding used by each carrier tool, support host manager injection and rebinding, and dispose only pack-owned managers. Carrier packs require the core release that supplies the binding; existing provider payloads remain usable.

## 0.1.5

### Patch Changes

- [#152](https://github.com/framerslab/agentos-extensions/pull/152) [`43bc75d`](https://github.com/framerslab/agentos-extensions/commit/43bc75d21b5f808ddea8d22ef7b6aac277e7799b) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

## 0.1.4

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.3

### Patch Changes

- [#78](https://github.com/framerslab/agentos-extensions/pull/78) [`d9561f1`](https://github.com/framerslab/agentos-extensions/commit/d9561f17043bb4953732d9599fe0a2a7c387394d) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.2

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
