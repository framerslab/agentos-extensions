---
'@framers/agentos-ext-channel-slack': minor
---

Add the `./outbound` entry for posting to a person's own Slack link without a Bolt app. `parseSlackLink` takes an incoming webhook link (`https://hooks.slack.com/services/...`) or a workflow webhook link (`https://hooks.slack.com/triggers/...`) and nothing else, and rebuilds it on Slack's host. `postToSlackLink` posts the text as JSON (escaped for an incoming webhook, as it is for a workflow's `text` variable), refuses text longer than 40,000 characters as the link gets it (`slackTextLength`), follows no redirect, gives up after a timeout whatever the fetch does with its signal, reads Slack's answer to a bound (through its body stream when there is one), and reads it into `link_gone`, `refused`, `invalid`, `rate_limited` (with `Retry-After`) and `unavailable`, a 2xx answer by its top-level `ok`. The package gains an `exports` map that keeps its root entry.
