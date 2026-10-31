# @framers/agentos-ext-channel-slack

Releases after 0.2.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-channel-slack@<version>`.

## 0.2.0

### Minor Changes

- [#438](https://github.com/framerslab/agentos-extensions/pull/438) [`68a4fbf`](https://github.com/framerslab/agentos-extensions/commit/68a4fbfcc4d7db9b1f2b9541b536c2994fbe0123) Thanks [@jddunn](https://github.com/jddunn)! - Add the `./outbound` entry for posting to a person's own Slack link without a Bolt app. `parseSlackLink` takes an incoming webhook link (`https://hooks.slack.com/services/...`) or a workflow webhook link (`https://hooks.slack.com/triggers/...`) and nothing else, and rebuilds it on Slack's host. `postToSlackLink` posts the text as JSON, escaped for both kinds of link (`&`, `<` and `>` as `&amp;`, `&lt;` and `&gt;`, so a `<!channel>`, `<!here>`, user or channel mention shows as written), refuses text longer than 40,000 characters once escaped (`slackTextLength`), follows no redirect, gives up after a timeout whatever the fetch does with its signal, reads Slack's answer to a bound through its body stream (an answer with no body stream is read by its status alone, and its `text()` is never called), and reads it into `link_gone`, `refused`, `invalid`, `rate_limited` (with `Retry-After`) and `unavailable`, a 2xx answer by its top-level `ok`. The package gains an `exports` map that keeps its root entry.

### Patch Changes

- [#446](https://github.com/framerslab/agentos-extensions/pull/446) [`0fb4aad`](https://github.com/framerslab/agentos-extensions/commit/0fb4aad3ec0c213344075dc77e44f738d07c2bcc) Thanks [@jddunn](https://github.com/jddunn)! - The pack and its two tools report the version in the package's own `package.json`, where they reported `0.1.0`.

## 0.1.3

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.2

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.
