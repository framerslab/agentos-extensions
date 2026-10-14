# Zoom Realtime Media Streams meeting provider

A provider for AgentOS's meeting channel that takes a Zoom meeting's audio through Zoom's Realtime Media Streams (RTMS). No participant joins the meeting: a person who is in the meeting as its host, an alternative host or an invitee starts your own Zoom app's stream, Zoom shows the room its own notice, and the meeting's mixed audio reaches a media worker you run, which publishes it into a LiveKit room once the meeting channel allows capture. From there AgentOS's listen session transcribes it.

It records no audio, keeps nothing, and reads no chat. It declares so (`joinsAsParticipant: false`, `postsChat: false`, `readsChat: false`, `audioPath: 'media_stream'`, `recordsAudio: false`, `transcribes: false`, `keeps: 'nothing'`, `stopPath: 'link'`), and a host writes its notice and its stop path from the declaration.

## Installation

```bash
npm install @framers/agentos-ext-meeting-zoom-rtms
```

It runs on Node.js 22 or later. Peer dependencies: `@framers/agentos` (`>=0.13.87`), and `@livekit/rtc-node` (`^1.1.0`, optional), which only the `./worker` entry and the media worker's command load.

## What you need

- A Zoom account on a paid plan with a Developer Pack, and a user-managed General app in it with the scopes `meeting:read:meeting_audio`, `meeting:update:participant_rtms_app_status`, `meeting:read:meeting` and `user:read:user`. Its event subscription takes RTMS Started, RTMS Stopped and RTMS Interrupted for meetings (`meeting.rtms_started`, `meeting.rtms_stopped`, `meeting.rtms_interrupted`). Zoom sends the app's deauthorization (`app_deauthorized`) to the app's deauthorization notification endpoint, a setting of its own outside the subscription. Point both at the route that calls `handleWebhook`. Zoom's review must pass before people outside your account can add the app.
- AgentOS's meeting channel (`@framers/agentos/io/channels/meetings`) with its manager and stores.
- A LiveKit server, and `@livekit/rtc-node` where the media worker runs.

## The three parts

```text
your host process                     your network                         Zoom
-----------------                     ------------                         ----
MeetingManager
  ZoomRtmsProvider --- POST /runs ---> media worker
        |                               |  joins the run's LiveKit room
        +--- PATCH rtms_app/status ------------------------------------> starts the stream
your webhook route <---------------------------------------------------- meeting.rtms_started
  provider.handleWebhook --- POST /zoom/webhook ---> media worker
                                        |  two WebSockets <------------- audio, active speaker
your events route <--- reports, under the run's token --- media worker
  manager.processProviderEvent
        |--- startCapture ------------> media worker --- audio ---> the run's LiveKit room
```

**The provider** runs in your host's process. It checks who may start a stream, registers the run with the worker, starts the stream at Zoom with the run owner's token, relays the manager's commands, verifies what reaches your events route, and takes Zoom's webhooks from your route. This wiring uses your existing `manager`, database `db`, encryption `key` and app credentials. Supply `bindConnection(runId, generation): Promise<void>` to persist provenance, `recordUsage(runId, usage: SupplierUsage): Promise<void>` to settle supplier cost, and `onDeauthorized({ zoomUserId, connections }): Promise<void>` for a person's removal of the app: it finishes the closure of the active runs of the connections it names and erases their retained content, as the example below does with the host's own `purgeConnection(ownerRef, generation)`. It must reject while any closure or erasure remains pending: the removal then stays in the inbox, its connections keep their credentials, and it is tried again. Apply `zoomTokenStoreDdl('acme_zoom')` and `durableInboxDdl('acme_zoom')` in the host's migration before constructing these stores.

`db` is a Postgres database that answers `run`, `get`, `all` and `transaction` with `?` placeholders, as `createPostgresAdapter` of `@framers/sql-storage-adapter` does. `key` is the 32-byte key of AgentOS's `SecretBox`, which seals both of a person's tokens and every webhook waiting in the inbox.

```ts
import { MeetingManager, SecretBox, SqlDurableInbox } from '@framers/agentos/io/channels/meetings';
import { SqlZoomTokenStore, ZoomRtmsProvider, ZoomTokenKeeper } from '@framers/agentos-ext-meeting-zoom-rtms';

const tokens = new ZoomTokenKeeper({
  store: new SqlZoomTokenStore({ db, tablePrefix: 'acme_zoom', box: new SecretBox(key) }),
  oauth: { clientId, clientSecret, redirectUri: 'https://acme.example/zoom/return' },
});
const zoom = new ZoomRtmsProvider({
  clientId,
  webhookSecret,
  workerUrl: 'http://zoom-media:8790',
  workerToken,
  workerId: 'zoom-media-1',
  tokens,
  runOf: (runId) => manager.getRun(runId),
  inbox: new SqlDurableInbox(db, 'acme_zoom', new SecretBox(key)),
  bindConnection,
  recordUsage,
  onDeauthorized: async ({ connections }) => {
    for (const connection of connections) await purgeConnection(connection.ownerRef, connection.generation);
  },
});
manager.registerProvider(zoom);

// Zoom's webhook endpoint: hand over the raw body and the headers
const answer = await zoom.handleWebhook({ headers, rawBody });
// respond with answer.status and answer.body

// before you reserve anything for a send
const place = await zoom.eligibility(ownerRef, meetingUrl);
```

`eligibility` answers `{ ok: true, role }`, the role being `host`, `alternative_host`, `invitee`, or `unknown` for a meeting the person's token cannot read (another account's, which Zoom's own start then decides), or `{ ok: false, reason }` with `not_started`, `not_invited`, `not_connected` or `bad_link`.

`zoomAuthorizeUrl`, `exchangeZoomCode` and `tokens.connect(...)` make a person's connection, with the Zoom user's id and account id that `zoom.api.me(accessToken)` answers; `tokens.disconnect(ownerRef)` ends it: it revokes the person's access token at Zoom, refreshing first a token at the end of its hour, since Zoom's revocation takes a live token, and removes the connection. `zoomTokenStoreDdl(prefix)` is the store's table for a host that runs its own migrations.

**The media worker** is a small HTTP service beside your agent. It holds each run's two connections to Zoom and its publisher in the run's room, joins the room when the run is accepted, and publishes only between `startCapture` and `suspendCapture`: a steady 20-millisecond frame with silence where Zoom sends none. It reports to your events route under the run's own token, one report at a time and in order. A report the route refuses, with a 4xx answer other than 408 and 429 (as it answers once the run's end is settled there), is not posted again; any other failure keeps that report, and every report after it, for the next try. A stream Zoom starts that no waiting run matches is closed at once. A run's closure the worker cannot prove itself is tried again one tick of its retry timer after the first failure, then after twice as many ticks each time, up to sixty (a minute at the default tick), while the provider proves it through Zoom's API. The worker writes one line when a run's reports or its closure begin to wait and one when they no longer do, never one a try.

It keeps a state file for each run it holds in `ZOOM_MEDIA_STATE_DIR` (default `/var/lib/zoom-media`), with the run's tokens and the reports not yet delivered, and in its `receipts` folder a receipt of each of Zoom's deliveries it acted on and of each stream it bound to a run, so a delivery handed over again changes nothing. It drops a receipt a day after writing it, but never the binding of a stream a run still holds. A receipt file it cannot read is set aside, `.corrupt` added to its name, with a warning line, and the worker starts. It creates the folder with mode 0700; keep it private, and put it on a volume that outlives the process, since a worker that starts again ends the runs its files name and delivers their reports. `POST /drain`, with the provider's credential, stops it accepting runs and answers how many it still holds; replace it when that number is zero.

```bash
ZOOM_MEDIA_WORKER_ID=zoom-media-1 \
ZOOM_MEDIA_CLIENT_TOKEN_FILE=/run/secrets/zoom_media_token \
ZOOM_CLIENT_ID=... ZOOM_CLIENT_SECRET_FILE=/run/secrets/zoom_client_secret \
ZOOM_WEBHOOK_SECRET_FILE=/run/secrets/zoom_webhook_secret \
ZOOM_MEDIA_REPORT_ORIGIN=https://acme.example \
agentos-zoom-media-worker
```

The other settings are listed at the top of `src/worker/main.ts`. Its lines are JSON on standard output, written through AgentOS's pino logger at the level `ZOOM_MEDIA_LOG_LEVEL` names (`info` when it names none, or `fatal`, `error`, `warn`, `debug`, `trace`, `silent`): each has a state for its message, such as `listening`, `report_pending` or `closure_pending`, and beside it a run's id, a status code or a count. A setting it cannot read is said in an error line, `failed_to_start`, and the process exits 1.

In code it is `ZoomMediaWorker` from `@framers/agentos-ext-meeting-zoom-rtms/worker`. Its `logger` option takes AgentOS's `ILogger` shape, a message and then the line's fields (`ZoomMediaLogFields`), as the process's AgentOS pino logger does.

**The speaker topic.** Mixed audio names nobody, so the worker sends each change of the active speaker as a text on the topic `zoom-rtms.speaker`, stamped with the published audio's clock. Whoever transcribes the room keeps a timeline:

```ts
import { SpeakerTimeline, attachSpeakerTimeline } from '@framers/agentos-ext-meeting-zoom-rtms';

const speakers = new SpeakerTimeline();
attachSpeakerTimeline(room, speakers); // the room is rtc-node's Room
const name = speakers.at(turn.startMs); // who was speaking when the turn began, or null
```

The publisher's token needs LiveKit's data grant (`canPublishData`) for the topic: without it the texts never reach the room. The texts arrive under the identity that token names, since LiveKit reads a participant's identity from its token: `bot` when AgentOS's `MeetingRoom` mints it with its default `botIdentity`. The provider's own `botIdentity` option does not change that identity. `attachSpeakerTimeline` reads the texts of `bot`; when your room's token names the bot otherwise, pass that identity as its third argument.

## As an extension pack

`createExtensionPack(context)` builds the token keeper, the API client and the provider from its options and registers the provider as the meeting-provider extension `zoomRtmsMeetingProvider`, whose `payload` is the provider. A secret comes from its option, then from `context.getSecret` under its secret id, then from its environment variable.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `clientId`, `redirectUri`, `workerUrl`, `workerId` | None | None | Yes | None |
| `clientSecret` | `zoom.clientSecret` | `ZOOM_CLIENT_SECRET` | Yes | None |
| `webhookSecret` | `zoom.webhookSecret` | `ZOOM_WEBHOOK_SECRET` | Yes | None |
| `workerToken` | `zoom.workerToken` | `ZOOM_MEDIA_WORKER_TOKEN` | Yes | None |
| `tokenStore` | None | None | No | In memory, which keeps no connection across a restart |
| `inbox` | None | None | No | In memory |
| `runOf`, `onDeauthorized`, `bindConnection`, `recordUsage` | None | None | No | None |
| `oauthBaseUrl`, `apiBaseUrl` | None | None | No | `https://zoom.us`, `https://api.zoom.us/v2` |
| `priority` | None | None | No | `50` |

Without `runOf`, a stream the worker cannot close is never stopped through Zoom's API. Without `onDeauthorized`, a removal of the app that names a stored connection stays pending, and every webhook after it waits behind it.

The provider keeps each of Zoom's webhooks in its inbox until it has acted on it, and acts on them in the order they came. A stream event the media worker refuses for good, with a 4xx answer other than 408 and 429 (a 409 for a stream it has fenced, for one), is dropped with a warning line that names the answer, and the next webhook is taken. Any other failure keeps that webhook and every one after it for the next attempt, which comes one second after the first failure and twice as long after each further one, up to thirty seconds; a removal of the app is never dropped.

The provider writes its warnings through `context.logger` (the `logger` option when you construct it yourself), each with a run's id or the first twelve characters of a webhook's digest (its key in the inbox) and a reason of its own: one line for each failed attempt at the inbox and one for each webhook it drops. One is a run whose closure cannot be proved yet: `usage` answers it as alive, answers every other run as the worker lists it, and tries the closure again on the next pass.

## How a run ends

| What happened | The run |
|---|---|
| The host stops the app from Zoom's controls, ejects its user, disables the app or all apps; a participant has the stream cancelled; Zoom revokes it; an admin disables the app | a stop command: your manager purges everything the run took |
| The app's user stops it from Zoom | leaves, `stopped_by_owner` |
| The app's user leaves, the meeting ends, or Zoom ends the stream for a reason no other row names | leaves, `ended` |
| Your manager tells it to leave | the worker sends Zoom's close request on the stream's signaling connection; when Zoom does not confirm the close, the worker knows no stream for the run, or the worker cannot be reached, the provider stops the stream through Zoom's API, and the run ends once the closure is confirmed |
| Zoom accepted the start and no stream came within two minutes | fences capture, confirms closure through REST, then leaves `permission_denied` with `host_did_not_allow` |
| The worker still holds the run a minute after its time limit | leaves, `cap` |
| Zoom ends the stream for a fault of its connections (its stop reasons 10 to 19 and 24), a connection is lost beyond Zoom's window for reconnecting, or Zoom names no address to connect to | `crashed`, with the word `stream_lost` |
| Zoom refuses a handshake of the stream | `crashed`, with the word `handshake_refused` |
| The media worker is stopped while it holds the run, or starts again with the run in its state files | `crashed`, with the word `worker_stopped` or `worker_restarted`, unless the run's end was already decided |
| Zoom refuses the start, or fails it for a moment, after the worker took the run | the provider takes the run back with the worker's `withdraw`: the worker closes what the run opened and posts nothing of its end, and your manager tries the dispatch again or ends the run as the two rows below say |
| Zoom will never start it (the person is not the host, an alternative host or an invitee; the account's setting; the app not allowed; the meeting does not support it, is not found or has not started), or the person's connection to Zoom is gone | the dispatch is refused for good: `permission_denied`, with a word from `ZOOM_START_REFUSALS` |
| Zoom refuses the start with its error 2310 (no active Developer Pack), or the worker has no free slot | the dispatch is refused for good: `no_capacity`, with the word `no_credits` for the first |

A report's `reason` is one of the meeting channel's leave reasons (`ZOOM_LEAVE_REASONS`, every `MeetingLeaveReason`) and its `message` one of the five words above (`ZOOM_END_WORDS`). The worker refuses a leave whose reason is not one of them, and the provider refuses a report that carries anything else.

## What it never does

The provider and the media worker never join a meeting, never write audio to disk, never read or post chat, never start a stream no run asked for, and never log a word, a name or an address of a meeting: their lines carry run ids, states and codes.

## Tests

`pnpm test` runs the unit and contract tests, the worker among them against a local server that speaks Zoom's side of the stream, and, once the pack is built (`pnpm run build`), the media worker's own process from `dist/worker/main.js`. The contract test of a stream recorded from a real meeting and redacted reads its recording from `test/fixtures/`, and is skipped while that folder holds none. The Postgres and LiveKit tests run when `ZOOM_RTMS_TEST_POSTGRES_URL` and `ZOOM_RTMS_TEST_LIVEKIT_URL` name a server; the repository's `Zoom RTMS` workflow runs the token store against Postgres, builds and packs the pack, and runs the worker against a LiveKit server. `agentos-zoom-rtms-capture` is the maintainer's tool that records a real stream and writes the redacted fixture; it is never part of a deployment.

## License

Apache-2.0
