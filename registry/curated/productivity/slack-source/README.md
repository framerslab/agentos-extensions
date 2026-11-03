# Slack source

This library reads the Slack channels a workspace chooses as account-source documents, for one public Slack app that every workspace installs through Add to Slack. It holds the app's bot OAuth v2 grant (the exact scope set, token rotation, the app's removal from a workspace), the events route's signature check and envelope parse, the queueing of the days an event changes into the connection's sync, the per-method ceilings by the installation's tier, a capped Web API client that sends every call through the host's account-source quota, the channel-day document, and a connector with a resumable sync provider that the account-source coordinator drives. It reads no direct message, no file and no channel shared with another organisation, and it posts, edits, deletes and leaves nothing in Slack.

Install it next to `@framers/agentos` 0.15.92 or later and `@framers/agentos-ext-account-sources` 0.11.2 or later, the release that carries sub-cursors, the pushed-event intake, selection modes and per-method ceilings. Both are peer dependencies with a floor and no upper bound. Node.js 22 or later is required.

## The grant

```ts
import { SlackOAuthFlow, SLACK_READ_SCOPES } from '@framers/agentos-ext-slack-source';

const callback = 'https://app.example.com/sources/slack/callback';
const client = { clientId, clientSecret, redirectUris: [callback] };

// The request that sends the person to Slack: keep the state in a short-lived, single-use record.
const begun = new SlackOAuthFlow(client, null).begin({ redirectUri: callback });

// The request Slack sends the person back to. `store` is a SealedTokenStore under the connection's namespace.
const flow = new SlackOAuthFlow(client, store);
const tokens = await flow.complete({ code, state, expectedState: begun.state, codeVerifier: '', redirectUri: callback });
const installation = SlackOAuthFlow.grantOf(tokens); // teamId, teamName, botUserId, appId, installerUserId, scopes
await flow.keep(connectionId, tokens);
```

`begin` builds `https://slack.com/oauth/v2/authorize` with the client id, the bot scopes joined by commas, the redirect address and a fresh state. It sends no PKCE challenge: the app is a confidential client holding its secret on the server, and Slack's PKCE marks an app a public client in a step only Slack support can undo. `complete` checks the state and exchanges the code at `oauth.v2.access` with the client's id and secret. The answer must be a bot token with a refresh token (token rotation on), the workspace, the bot user and the app, and its scopes must be exactly the set the flow holds: `SLACK_READ_SCOPES` by default, or the live manifest's set the host names in `scopes`, the same for every workspace. A grant with a scope missing (`scope_missing`) or one more (`scope_excess`) is removed from its workspace with `apps.uninstall` before the `SlackOAuthFault` is thrown, and the fault's `cleanup` reads `confirmed` or `unconfirmed`.

`SLACK_READ_SCOPES` holds the eight read scopes: `channels:history`, `groups:history`, `channels:read`, `groups:read`, `channels:join`, `users:read`, `users:read.email` and `team:read`. No write, manage, direct-message, file, search, admin or user scope.

`keep` hands the store the refresh token and the grant's metadata, never the access token. `accessToken(key)` answers a usable token and refreshes it one refresh at a time per key through `oauth.v2.access` with `grant_type=refresh_token`; Slack's access token lasts 12 hours and each refresh answers a new refresh token, which the store receives before the new access token is used. A refresh whose scopes differ from the set is refused, and the host puts the connection in `needs_grant`. `revoke(token)` ends one token with `auth.revoke`, which under rotation leaves the installation in place; `uninstall(token)` removes the app from the workspace with `apps.uninstall`, which revokes every token of the installation and answers whether Slack confirmed it.

Every call is capped at 65,536 bytes, bounded by one 15-second deadline and stopped by the caller's cancellation. Fixed `SlackOAuthFault` reasons carry no Slack text or credential; `slackError` keeps Slack's error code only when the flow names it. Stand-in endpoints are accepted on CI alone, at a loopback or `.invalid` host.

## The events route

```ts
import { verifySlackSignature, parseSlackEnvelope, slackRetryOf, enqueueSlackEvent } from '@framers/agentos-ext-slack-source';

const check = verifySlackSignature({ headers: request.headers, rawBody, signingSecret, now: Date.now() });
if (!check.valid) return new Response(null, { status: 401 });
const envelope = parseSlackEnvelope(rawBody);
if (envelope.kind === 'url_verification') return Response.json({ challenge: envelope.challenge });
// Store the delivery keyed by envelope.eventId in the host's delivery log, then answer 200 within three seconds.
// The worker applies it later: for a message event it queues the channel-day into the connection's sync.
await enqueueSlackEvent(coordinator, scope, envelope);
```

`verifySlackSignature` checks the `v0` HMAC-SHA256 of `v0:{timestamp}:{raw body}` under the app's signing secret in constant time, and refuses a request whose `x-slack-request-timestamp` lies more than five minutes from the clock either way (`stale`), one without the two headers (`missing`) and one whose signature differs (`mismatch`). `parseSlackEnvelope` reads Slack's three envelopes, `url_verification`, `event_callback` and `app_rate_limited`, refuses a body past 1,048,576 bytes and anything Slack does not send, and types the event inside: a new message (a thread reply among them), an edit's new version, a deletion, a notice it does not keep (a join, a topic), a channel change (created, renamed, archived, unarchived, deleted, shared, unshared, its id changed, the bot removed, made private), a membership change with its inviter, and the installation events (`app_uninstalled`, `tokens_revoked`, `user_change`, `app_home_opened`). A direct message's event is typed `other`. `slackRetryOf` reads `x-slack-retry-num` and `x-slack-retry-reason`; the delivery log's key makes a retry a no-op.

`slackEventSources` names the channel-days an event changes: the message's day, or its thread parent's day for a reply, which the parent's document holds. `enqueueSlackEvent` queues them with the reason `event` through `AccountSourceSync.enqueue`, into the connection's open cycle or a new incremental one, and answers null for an event that changes no message.

## The ceilings

```ts
import { SourceQuota } from '@framers/agentos-ext-account-sources';
import { slackCeilings, slackQuotaWeights, slackTier } from '@framers/agentos-ext-slack-source';

const tier = slackTier(process.env.SLACK_PUBLIC_APPROVED_ON ?? null, Date.now());
const quota = new SourceQuota(db, { ceilings: slackCeilings(tier), policy: { ...budgets, weights: slackQuotaWeights() } });
```

Slack limits each Web API method per workspace per app. Every installation reads at one tier: `unlisted` until Slack approves the Marketplace listing, `listed` from the approval day the host records. The table is keyed to the tier alone, never to a workspace.

| Method | `unlisted` | `listed` |
|---|---|---|
| `conversations.history`, `conversations.replies` | 1 a minute, 15 objects a call | 50 a minute, 999 objects a call |
| `conversations.list` | 20 a minute, 999 objects | the same |
| `conversations.join`, `conversations.info`, `conversations.members` | 50 a minute | the same |
| `users.info` | 100 a minute | the same |
| `team.info`, `auth.test` | a weight, no ceiling of their own | the same |

`SlackApi` sends each call through the quota under its method, with a new attempt id and the objects it asks for, so the quota holds each ceiling per workspace. A 429, or Slack's `ratelimited`, records `Retry-After` for that method of that workspace alone (`defer` with the method) and throws `rate_limited` with its time; the other methods go on. Answers are read under a 4,194,304-byte cap by default. Slack's errors about one item become a `SlackApiFault` (`not_found`, `no_access`, `archived`); an ended grant becomes `grant_rejected`, a missing scope `insufficient_scope`, and Slack's own outages `provider_unavailable`.

## The documents

A source is one channel's messages of one UTC day, `{channel}:{yyyy-mm-dd}`, and one document. `mapChannelDay` renders it: a line per message in time order, `{name} {h:mm AM}: {text}` in UTC, each thread's replies indented under their parent whenever they were posted, a file shown as `[file: {name}]` and never read, mentions, channels and links resolved to text, the newest version of an edited message, no deleted message (the host's tombstones), and no post of SaysHere's own bots. A bot's or an app's post is kept under its name. Each message is one span, kept the shorter of the host's `retainedDays` from the day and the connection's retention window (`channelDayExpiry`). A day past the store's bounds, 1,000 messages or 1,048,576 characters, keeps its messages in time order up to them, with `complete` false in its metadata. A day with nothing left renders as null, so the host removes its document.

The source-detail address is the host's own path, never a Slack link. The retained days, retention past the read, deletion at Disconnect, the people project of a private channel and every export rule stay with the host.

## The connector and the sync

```ts
import { SlackApi, slackSourceSync } from '@framers/agentos-ext-slack-source';

const sync = slackSourceSync({
  scope,
  coordinator: { store, prepare, lifecycle },
  connector: async () => ({
    api: new SlackApi({ accessToken, quota, projectKey, mailboxKey: installationKey }),
    connectedAt, backfillDays: backfillOn ? backfillDays : null, retainedDays, ownBotIds: [botId],
    permission, sourceDetailUrl, revoke, channelStart, admits, tombstones, held, people,
  }),
});
await sync.run(scope, 'scheduled');
```

`SlackSourceConnector` reads by the connection's channel set, the policy's `selectionMode`: `invited` (the default) reads the public and private channels someone invited the bot into and joins nothing; `public` joins every public channel and reads no private one; `all` joins every public channel and reads the private channels the bot was invited into. No set reads an archived channel, a channel shared with another organisation or a direct message. The host's `admits` can keep out a channel its own record excludes, such as a public channel a wider set joined earlier.

Slack's events are the live read. The scan names nothing. The history phase walks the channel set when the connection has read no channel or its last walk is a reconcile period old, and sends no request between walks. A walk reads each channel's history from its anchor, the instant its last walk read up to (its sub-cursor), or, for a channel never read, from its read-from bound: its start (`connectedAt`, or `channelStart` for a channel the bot arrived in later) less `backfillDays` when Backfill is on, and never more than `retainedDays` back. The connector holds no number of days of its own: the host sends both from its plan source, the backfill days at most the retained days. A walk names the days of the messages it finds and, for a channel read before, one slice of its retained days, so seven daily walks read every retained day again; it stages the walk's cutoff as each channel's sub-cursor, which the store commits with the cycle. A host that turns Backfill on or off stores a changed policy, which clears every sub-cursor.

`readSource` reads one channel-day. A day the host holds whole from the events (`held`) is rendered with no request. Otherwise the channel's details come first: a channel gone, shared with another organisation or outside the set answers the day `gone`. Then the day's messages and its threads' replies, page by page within each method's ceiling, and the people's names (the host's `people` cache, then `users.info`). A method's minute without room is waited for within the read's bound, `waitMs`, 80,000 milliseconds by default, inside the 90,000 a provider call may take (`slackSourceSync` gives the coordinator that bound and a run 180,000); a later time is answered as a retry. At the `unlisted` tier one read can wait out two minutes of `conversations.history`, so a day of more than 30 messages or more than two threads at that tier is read from the events through `held`, or completes once the listing raises the tier.

The original interface lists, reads and reports changes of selected channel-days, at most 100 in one selection, under the selection's mode or the connector's `mode`. An empty selection sends no request.

## Tests

The suites run against `test/standin.ts`, a loopback stand-in for Slack's Web API and OAuth with synthetic channels, people, messages and threads: the exchange with exact, missing and excess scopes and the refresh under rotation; the signature with a valid, a wrong and a five-minute-stale request; each envelope and the event intake; the anchor per channel, a page under the ceiling, the wait for one method after its `Retry-After`, and the backfill days; the three channel sets and Slack Connect; the channel-day document; and the account-source conformance cases under each set. `test/sync.postgres.spec.ts` runs the read end to end on PostgreSQL, on the released store, coordinator and quota with the Slack ceilings, and skips without `AGENTOS_TEST_POSTGRES_URL`, which CI sets.

Protocol references: https://docs.slack.dev/authentication/installing-with-oauth, https://docs.slack.dev/authentication/using-token-rotation, https://docs.slack.dev/authentication/verifying-requests-from-slack, https://docs.slack.dev/apis/events-api and https://docs.slack.dev/apis/web-api/rate-limits.
