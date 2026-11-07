# Discord Channel Extension

Bidirectional Discord messaging for AgentOS via `discord.js`.

## What It Provides

- `discordChannelSendMessage`
- `discordChannelSendMedia`
- `discordChannel`
- `createWebhookSender`, a plain-text post to a Discord webhook, with no bot and no discord.js (see [The webhook sender](#the-webhook-sender))

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect, poll, or receive webhooks.
- Enable it through `createCuratedManifest({ channels: ['discord'] })` or a custom extension manifest.

## Required Secret

- `discord.botToken`

## Direct messages and unmentioned server messages

Three options decide which messages reach the host and where the pack reaches Discord. Each falls back to an environment variable, then to a default that keeps the pack's behaviour as it has always been:

| Option | Environment variable | Values | Default |
|---|---|---|---|
| `directMessages` | `DISCORD_DIRECT_MESSAGES` | `ignore`, `accept` | `ignore` |
| `channelMessages` | `DISCORD_CHANNEL_MESSAGES` | `delayed`, `immediate` | `delayed` |
| `apiBase` | `DISCORD_API_BASE` | the REST API's base address | discord.js's own, `https://discord.com/api` |

```ts
createExtensionPack({
  options: { botToken, directMessages: 'accept', channelMessages: 'immediate' },
});
```

**`directMessages`.** With `ignore`, the pack drops every direct message (its default intents do not ask Discord for them), and a slash command sent in a direct message is answered "Use me in server channels (not DMs)." With `accept`, the pack adds the `DirectMessages` intent to its intents at login, the defaults or the ones the `intents` option names, and turns on discord.js's `Channel` partial. Discord sends a direct message to a bot only under that intent ([gateway intents](https://discord.com/developers/docs/events/gateway#list-of-intents)), a standard intent that needs no switch in the Developer Portal, and a direct message's content arrives without the privileged Message Content intent. discord.js drops a message in a channel it has not cached unless the `Channel` partial is on, and a first direct message from anyone is in such a channel. Each direct message then reaches the host at once, with `conversationType: 'direct'`, and a slash command sent in a direct message runs as it does in a server channel.

Without `DISCORD_GUILD_ID` the pack registers its slash commands globally, as it always has, with Discord's default contexts, which include direct messages with the bot for anyone who shares a server with it. With `DISCORD_GUILD_ID` set it registers them in that server, and Discord offers a server's commands in that server alone, never in a direct message ([application commands](https://discord.com/developers/docs/interactions/application-commands#registering-a-command)). So with `DISCORD_GUILD_ID` and `accept`, the pack also registers the same commands globally with the `BOT_DM` context alone ([interaction contexts](https://discord.com/developers/docs/interactions/application-commands#interaction-contexts)): they appear in direct messages with the bot, and the server does not list each command twice. With `ignore` and `DISCORD_GUILD_ID`, the commands go to that server alone. The sync creates or edits commands and never deletes one, so commands an earlier `accept` registered for direct messages stay registered after a switch back to `ignore`, and a direct message that runs one is answered "Use me in server channels (not DMs)." A later start without `DISCORD_GUILD_ID`, or one whose server sync fails and falls back to the global commands, gives each such command Discord's default contexts back (servers, direct messages with the bot, and other direct and group messages): Discord's edit changes only the fields it is given ([edit global application command](https://discord.com/developers/docs/interactions/application-commands#edit-global-application-command)), so an edit that named no contexts would leave it out of every server.

**`channelMessages`.** This decides what happens to a server message that neither mentions the bot nor replies to it. A mention or a reply always reaches the host at once. With `delayed`, the pack drops such a message in a feed channel (`#tech-news`, `#world-news` and the others the adapter lists) or when it opens with a greeting or filler word, is five characters or fewer, or is a lone custom emoji or link. It holds any other for two minutes and drops it when anyone else posts in that channel first. With `immediate`, every such message reaches the host at once, and none is dropped, held or cancelled. The host's input guardrails then see every message the bot can read, and the agent's turn decides whether to answer. Each message is a turn, so in a busy server `immediate` costs a model call for every message posted where the bot can read.

**`apiBase`.** This becomes discord.js's `rest.api`, and the gateway's address comes from `GET /gateway/bot` there, as it comes from Discord. Tests point it at a stand-in Discord.

An unknown value of `directMessages` or `channelMessages`, in the options or the environment, fails the pack's creation with an error that names the setting, so a misspelt policy never runs as the default. Environment values are read trimmed and in any case.

## A rejected bot token

When Discord rejects the bot token, the adapter emits one `error` event per start of the service, and the service stops:

```ts
adapter.on((event) => {
  if (event.data?.code === 'auth_failed') {
    // event.data is { code: 'auth_failed', channel: 'discord' }: ask for a new token.
  }
}, ['error']);
```

Discord rejects a token in three ways, and each one counts:

- the login fails with discord.js's `TokenInvalid` error, because the gateway lookup (`GET /gateway/bot`) answered 401; the start rejects with that error;
- a REST call made with the bot token answers 401 (a send, a fetch, the slash command sync); interaction replies use the interaction's own token and do not count;
- the gateway closes the session with code 4004, Authentication failed; discord.js does not reconnect after it.

The event names the channel and carries no token and no message text. A token rejected while the pack activates is rejected before a host can subscribe, so a handler that subscribes for `error` events afterwards gets the event once, right after it subscribes. The service writes one warning, which names no token. `DiscordService` exposes `tokenRejected` and `onTokenRejected(handler)`, and the pack exports `CHANNEL_AUTH_FAILED_CODE` and `isDiscordTokenRejected(err)`, which says whether an error from discord.js is a rejected bot token (a 401 on an interaction's or a webhook's own route is not).

A server error (500 and up) or a dropped connection is not a rejected token: the REST client retries a 5xx three times, as discord.js does, and the channel keeps running.

A slash command sync at start that Discord refuses with a 401 makes the start reject with that error; with `DISCORD_GUILD_ID` set, the sync does not go on to the global commands. If the sync fails for any other reason, the service writes one warning and starts without its slash commands.

## The webhook sender

The pack reaches Discord in two ways. The bot client (`DiscordService`, the adapter and the tools above) logs in with a bot token and serves the channels an agent talks in. `createWebhookSender` posts plain text to one channel through a webhook's URL, for a product's staff alerts: no bot and no login. Its code calls nothing from discord.js and starts no client, though importing the package's root still loads discord.js, which the bot client needs.

```ts
import { createWebhookSender } from '@framers/agentos-ext-channel-discord';

// The URL is a secret the product reads from its secret store at build time.
const alerts = createWebhookSender({ url: webhookUrl, timeoutMs: 5_000, logger });

const answer = await alerts.post({ content: 'A request has waited 30 minutes.', signal });
if (answer.outcome === 'sent') {
  // answer.deliveryId is the id of the message Discord created.
} else if (answer.outcome === 'retry') {
  // Post again after answer.afterMs.
} else {
  // answer.kind is 'status' (answer.status names it), 'no_answer' or 'refused'.
}
```

Each post sends `POST <url>?wait=true` with `Content-Type: application/json` and the body `{ "content": "...", "allowed_mentions": { "parse": [] } }`. It sends no `username` or `avatar_url`, so the webhook's own name and picture show.

- **`wait=true`** makes Discord wait for the message to be saved before it answers, and return the created message. Without it, a message that is not saved returns no error ([Execute Webhook](https://docs.discord.com/developers/resources/webhook)).
- **`content`** is the message's text, up to 2,000 characters ([Execute Webhook](https://docs.discord.com/developers/resources/webhook)). The sender refuses an empty post, or one over 2,000 characters, before any request.
- **`allowed_mentions: { parse: [] }`** suppresses every mention in the message: Discord parses none of its user, role, `@everyone` or `@here` mentions ([Allowed Mentions](https://docs.discord.com/developers/resources/message)). Discord recommends `allowed_mentions` on webhook posts "to prevent unexpected mentions" ([Execute Webhook](https://docs.discord.com/developers/resources/webhook)).
- **A 429** carries a JSON body whose `retry_after` is the number of seconds to wait, and Discord asks clients to wait by the `Retry-After` header or that field ([Rate Limits](https://docs.discord.com/developers/topics/rate-limits)).
- **No redirect is followed.** A 301 or 302 followed on a POST becomes a GET with no body ([Fetch, HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)), and a GET of a webhook's URL returns the webhook object ([Get Webhook with Token](https://docs.discord.com/developers/resources/webhook#get-webhook-with-token)), whose `id` would read as a created message although none was posted. A 3xx is `failed` with its status. `http://discord.com` answers a webhook POST with a 301 to `https://`, so the URL starts with `https://`.

`post` resolves to one of three answers and never throws:

| Answer | When |
|---|---|
| `{ outcome: 'sent', deliveryId }` | a 2xx whose body is the created message; `deliveryId` is its `id` |
| `{ outcome: 'retry', afterMs, status: 429 }` | a 429; `afterMs` is the body's `retry_after`, else the `Retry-After` header, else 30 seconds |
| `{ outcome: 'retry', afterMs: 5_000, status }` | a 2xx with no message in its body (a 204, or a body with no `id`): the post is unconfirmed, and delivery is at least once |
| `{ outcome: 'failed', status, kind: 'status' }` | any other status, a redirect included |
| `{ outcome: 'failed', status: null, kind: 'no_answer' }` | a network failure, the timeout, or the caller's `signal` aborting |
| `{ outcome: 'failed', status: null, kind: 'refused' }` | content that is empty or over 2,000 characters, refused before any request |

One deadline, `timeoutMs` (5,000 by default), covers the whole exchange, the body's read included: a response whose headers come at once over a body that never ends still ends within it, as `no_answer`. A caller's `signal` (an outbox's claim deadline, say) joins that deadline, and a signal already aborted sends nothing. An error status ends the request as soon as its answer is given, so an error body that never ends holds no connection. Retrying is the caller's: the sender posts once per call.

The webhook URL carries the webhook's token, so the sender treats it as a secret. It appears in no answer, no error and no log line; the one line the sender writes, through the `logger` option's `warn`, is `discord_webhook` with `{ outcome: 'no_answer' }`. A `url` that is not a valid URL makes `createWebhookSender` throw a `TypeError` that leaves the value out.

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
