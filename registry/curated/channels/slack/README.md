# Slack Channel Extension

Bidirectional Slack messaging for AgentOS via `@slack/bolt`.

## What It Provides

- `slackChannelSendMessage`
- `slackChannelSendMedia`
- `slackChannel`

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect, poll, or receive webhooks.
- Enable it through `createCuratedManifest({ channels: ['slack'] })` or a custom extension manifest.

## Required Secrets

- `slack.botToken`
- `slack.signingSecret`
- `slack.appToken`

## Posting to a person's own Slack link (`./outbound`)

A host that only posts messages, such as notes a person chose to send to a channel, takes the `./outbound` entry. It
loads no Bolt app, opens no port and needs none of the secrets above: the person makes the link in their own Slack
workspace and the host keeps it as the secret it is.

```ts
import { parseSlackLink, postToSlackLink } from '@framers/agentos-ext-channel-slack/outbound';

const link = parseSlackLink(pasted); // null for anything that is not a Slack link
if (link === null) throw new Error('not a Slack incoming webhook or workflow link');

const outcome = await postToSlackLink(link, 'Decisions: ship on Friday.');
if (!outcome.ok && outcome.reason === 'link_gone') {
  // The link was removed, its channel archived or its workspace closed: ask the person for a new link.
}
```

`parseSlackLink` takes two kinds of link, and nothing else:

- an incoming webhook of an app in the person's workspace, `https://hooks.slack.com/services/<workspace>/<B...>/<secret>`
  ([Slack's guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks));
- a workflow's webhook trigger, `https://hooks.slack.com/triggers/<workspace>/<number>/<secret>`, made in Workflow
  Builder on Slack's paid plans ([Slack's help](https://slack.com/help/articles/360041352714)). The workflow needs one
  text variable named `text`, which its message step shows.

Any other scheme, host, port (the default one written out included), user name, query, fragment, backslash or path is
refused, and the link it returns is rebuilt on
`hooks.slack.com` from the checked path, with its `kind`, its `workspace` id and its last four characters (`ending`)
for a person to tell their links apart.

`postToSlackLink(link, text, { fetch, timeoutMs, signal })` posts `{ "text": ... }` as JSON, with the text escaped
(`&`, `<` and `>` as `&amp;`, `&lt;` and `&gt;`) for either kind of link. Slack reads an incoming webhook's text as its
message formatting ([Slack's formatting guide](https://docs.slack.dev/messaging/formatting-message-text)), and a
workflow started by a webhook takes the same formatting in its variables
([Slack's platform blog](https://medium.com/slack-developer-blog/the-latest-from-workflow-builder-8e0278ddc569)), so an
unescaped `<!channel>`, `<!here>`, `<@U...>` or `<#C...>` would notify people or show a link the writer never wrote.
`escapeSlackText` is the same escaping on its own. The post follows no redirect, gives up after 10 seconds unless
`timeoutMs` says otherwise, and refuses text with nothing but spaces or with more than `SLACK_TEXT_LIMIT` (40,000)
characters as the link gets it, the length above which Slack truncates a message
([chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)). `slackTextLength(kind, text)` is that
length, the escaped text's, for a host to show or check before a post.

It resolves with `{ ok: true }`, or `{ ok: false, reason, retryAfterSeconds?, slackError? }`:

| `reason` | What Slack said | What a host does |
|---|---|---|
| `link_gone` | The link no longer takes posts: `no_service`, `no_active_hooks`, `invalid_token`, `channel_is_archived`, `team_disabled` and the like, or a 404 or 410 | Ask for a new link |
| `refused` | The workspace refuses the post: `action_prohibited`, `posting_to_general_channel_denied`, or a 403 | Tell the person; a new link to another channel may post |
| `invalid` | Slack refused the message: `invalid_payload`, `no_text`, `parameter_validation_failed` (a workflow's JSON Slack cannot take), or another 4xx | Check the text, and that the workflow's one variable is named `text` |
| `rate_limited` | A 429; `retryAfterSeconds` is its `Retry-After`, 1 to 3600 | Wait that long; Slack takes about one post a second a link ([rate limits](https://docs.slack.dev/apis/web-api/rate-limits)) |
| `unavailable` | No answer in time, a 5xx, a redirect | Try again later |

`slackError` is Slack's error code when the answer carried one; nothing else from Slack's answer is returned. A 2xx
answer is a post Slack took unless it is a JSON object whose top-level `ok` is false, so a post is never reported as
failed and sent twice. Slack's answer is read from its body stream, to 8,192 characters at most, and the stream is then
let go. An answer a `fetch` gives with no body stream is read by its status alone: its `text()` is never called, since
that holds the whole answer at once however long it is. The timeout and the `signal` end the post themselves, so a
fetch that leaves an answer's body pending still answers `unavailable` on time.

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
