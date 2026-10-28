---
'@framers/agentos-ext-channel-slack': minor
---

Add the `./outbound` entry for posting to a person's own Slack link without a Bolt app. `parseSlackLink` takes an incoming webhook link (`https://hooks.slack.com/services/...`) or a workflow webhook link (`https://hooks.slack.com/triggers/...`) and nothing else, and rebuilds it on Slack's host. `postToSlackLink` posts the text as JSON (escaped for an incoming webhook, as it is for a workflow's `text` variable), follows no redirect, gives up after a timeout, and reads Slack's answers into `link_gone`, `refused`, `invalid`, `rate_limited` (with `Retry-After`) and `unavailable`. The package gains an `exports` map that keeps its root entry.
