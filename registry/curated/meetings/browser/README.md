# Browser meeting bot provider

This pack gives the AgentOS meeting-participant channel (`@framers/agentos/io/channels/meetings`) a provider for Google Meet and Microsoft Teams. The provider hands each run to the scheduler on a worker machine over HTTP and authenticates the reports that scheduler forwards by the run's worker token. It never drives a browser itself.

## Installation

```bash
npm install @framers/agentos-ext-meeting-browser
```

Peer dependency: `@framers/agentos` (`>=0.13.82`, the first release that exports `@framers/agentos/io/channels/meetings`).

## Usage

```ts
import { EXTENSION_KIND_MEETING_PROVIDER } from '@framers/agentos';
import type { IMeetingBotProvider } from '@framers/agentos/io/channels/meetings';
import { createExtensionPack } from '@framers/agentos-ext-meeting-browser';

// The client credential comes from MEETING_SCHEDULER_TOKEN when no option or secret gives it.
const pack = createExtensionPack({
  options: { schedulerUrl: 'https://scheduler.example.com', workerId: 'worker-1' },
});
const descriptor = pack.descriptors.find((d) => d.kind === EXTENSION_KIND_MEETING_PROVIDER);
manager.registerProvider(descriptor!.payload as IMeetingBotProvider); // the host's MeetingManager
```

## Configuration

`createExtensionPack` throws when `schedulerUrl`, `workerId` or the client credential is missing. The credential resolves from `schedulerToken`, then the secret `meetings.schedulerToken`, then the environment variable that `schedulerTokenEnv` names.

| Option | Required | Default | What it sets |
| --- | --- | --- | --- |
| `schedulerUrl` | Yes | None, throws if absent | The scheduler's base url on the worker |
| `workerId` | Yes | None, throws if absent | The worker's id, kept on each run's dispatch record |
| `schedulerToken` | Yes, here or as the secret or the environment variable | The secret `meetings.schedulerToken`, then the environment | The client credential the scheduler accepts |
| `schedulerTokenEnv` | No | `MEETING_SCHEDULER_TOKEN` | The environment variable read for the credential |
| `botIdentity` | No | `bot` | The identity the bot publishes under in the run's LiveKit room |
| `platforms` | No | `['google_meet', 'microsoft_teams']` | The platforms this worker serves |
| `fetchImpl` | No | The global `fetch` | The `fetch` the provider calls the scheduler with |
| `priority` | No | `50` | The descriptor's priority |

The pack returns one descriptor of kind `meeting-provider`, `browserMeetingProvider`, whose payload is a `BrowserMeetingProvider` named `browser`.

## What the provider does

- **Join links.** `checkJoinUrl` accepts `https://meet.google.com/xxx-xxxx-xxx` links and Microsoft Teams join links on `teams.microsoft.com` (`/l/meetup-join/...`) and `teams.live.com` (`/meet/...`). It refuses every other host, an address literal included, any scheme but `https`, a link that carries credentials, and a platform the worker does not serve.
- **Dispatch.** `dispatch` posts the run to the scheduler's `POST /runs` with the run's link, bot name, notice, stop phrase and limits, the room's url and publish token, the per-run worker token and the report url. A `201` dispatches the run, a `409` throws `NoCapacityError`, and any other status throws.
- **Commands.** `command` posts `startCapture`, `suspendCapture`, `postChat`, `leave` or `kill` to `POST /runs/:id/command`. A `404` means the scheduler no longer holds the run, and is not an error.
- **Usage.** `usage` reads `GET /runs` and answers each run asked for (every run the scheduler lists when none is named) with `alive` (the scheduler lists it in a state other than `exited`) and the seconds the scheduler counted.
- **Deletion.** `deleteRun` calls `DELETE /runs/:id` and answers `{ deleted: false }`: the provider keeps no copy of a run. A `404` means the scheduler no longer holds the run. Any other refusal throws, so the purge that called it tries again.
- **Reports.** The scheduler posts each report to the run's report url as a `ReportPost` under `Authorization: Bearer <worker token>`. `verifyEvent` accepts a report whose bearer token hashes to the run's `dispatch.workerTokenHash`. `parseEvent` returns one event whose id is `browser:<run>:<seq>:<event>`, so a report delivered twice keeps one id.

Every request to the scheduler carries `Authorization: Bearer <schedulerToken>` and follows no redirect.

The provider declares itself a participant that posts and reads the chat, publishes the call's audio into the run's LiveKit room, records and transcribes nothing, keeps nothing, and leaves on the stop phrase in the chat: `{ joinsAsParticipant: true, postsChat: true, readsChat: true, audioPath: 'livekit_room', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'chat' }`.

## The protocol

`src/protocol.ts` holds the zod schemas of the messages between the scheduler and a bot container (`JobMessage`, `CommandMessage`, `AckMessage`, `ReportMessage` and their union `ChannelMessage`) and of the scheduler's HTTP API (`StartRunRequest`, `ReportPost`, `RunStatus`, `Capacity`), with `reportEventId`. The package root exports them all.

## The scheduler

The scheduler runs on each worker machine beside Docker. It leases a slot per run, starts one bot container per run under a fixed policy, holds each container's command channel, relays the provider's commands down it, and forwards the container's reports to the run's report url. The meeting manager's job store stays the source of truth: the scheduler holds only the runs it was given.

```bash
MEETING_WORKER_ID=worker-1 MEETING_SLOTS=2 MEETING_CLIENT_TOKEN_FILE=/srv/meeting/secrets/client \
MEETING_BOT_IMAGE=ghcr.io/framerslab/agentos-meeting-bot:0.1.0 MEETING_LISTEN=127.0.0.1:8788,10.90.0.1:8788 \
MEETING_CHANNEL_URL=ws://10.90.0.1:8788/channel MEETING_STATE_ROOT=/srv/meeting/secure/state \
MEETING_PROFILES_ROOT=/srv/meeting/secure/profiles MEETING_SECCOMP_PROFILE=/srv/meeting/seccomp.json \
agentos-meeting-scheduler
```

| Variable | Required | What it sets |
| --- | --- | --- |
| `MEETING_WORKER_ID` | Yes | The worker's id: on every forwarded report, in `GET /capacity`, and on its containers' labels |
| `MEETING_SLOTS` | Yes | How many runs the worker holds at once |
| `MEETING_CLIENT_TOKEN_FILE` | Yes | A file holding the client credential (16 characters or more) the provider presents; the value itself never sits in the environment |
| `MEETING_BOT_IMAGE` | Yes | The bot image, by tag or digest |
| `MEETING_LISTEN` | Yes | The addresses it listens on, `host:port` separated by commas (`[::1]:8788` for IPv6) |
| `MEETING_CHANNEL_URL` | No | The channel url the containers reach; default `ws://<first address>/channel` |
| `MEETING_STATE_ROOT` | No | The folder of the runs' state files, on an encrypted volume; without it a restart takes no run back |
| `MEETING_PROFILES_ROOT` | No | The identity pool's folder; without it a Google Meet run joins with a fresh browser profile |
| `MEETING_SECCOMP_PROFILE` | No | A seccomp profile file; the scheduler sends its JSON with each container's security options |
| `MEETING_RESOLVE_ALLOW` | No | Test hosts, separated by commas, whose links it takes over `http` at any address; empty in production |

It logs JSON lines through AgentOS's `createLogger`. The lines carry run ids, states, reasons and counts, never a meeting link, a name, a chat line or a token. `SIGTERM` stops it and leaves the containers running for the next start to take back.

TLS belongs to the reverse proxy in front of the scheduler. Every route but `GET /health` takes the client credential as a bearer token:

| Route | Answer |
| --- | --- |
| `GET /health` | `200` with the worker id |
| `GET /capacity` | The `Capacity`: the slots, the busy count and the pause flag |
| `GET /runs` | A `RunStatus` per run it holds; an exited run stays listed for an hour after its exit, its seconds stopped at the exit |
| `POST /runs` | `201` with the run's `RunStatus`, also for the same run sent again with its token; `400` for a refused link or body; `409` when paused, when the slots are full, or when a Google Meet run finds no free identity; `413` for a body over 64 KiB; `503` when another start of the same run got there first |
| `POST /runs/:id/command` | The container's acknowledgement (`200`, or `500` when it refused or did not answer within 10 seconds); `kill` stops the container itself and answers `200`; a `leave` before the bot has opened its channel stops its container, and one while a reconnecting bot's channel is down answers `202` and goes down the next channel; `409` for any other command before the bot has opened its channel; `404` for a run it does not hold, and for any command but `kill` once the run has ended |
| `DELETE /runs/:id` | Stops and removes the container and forgets the run; nothing is reported for it afterwards |

**The join link.** A link must be a Google Meet or Microsoft Teams join link (the provider's `classifyJoinUrl`), and every address its host resolves to must pass AgentOS's `isPublicNetworkAddress` (from `@framers/agentos/io/media/images`, the rule AgentOS's own guarded fetches apply): loopback, private, link-local, carrier-grade NAT, documentation, benchmarking, multicast, reserved and unallocated ranges are refused, and so is an IPv6 address that carries a refused IPv4 one (IPv4-mapped, NAT64, 6to4), whatever its spelling. A host named in `MEETING_RESOLVE_ALLOW` is taken over `http` or `https` at any address, names its platform in its `platform` query parameter, and its job carries `adapter: 'fixture'`, so the bot drives the fixture page's adapter.

**The container.** Nothing customer-supplied reaches Docker. A container gets the image and limits of the scheduler's configuration, the bots' network (`meeting-bots`), no capabilities, a read-only root with `tmpfs` scratch folders, `no-new-privileges` and the seccomp profile, and only two environment variables: the channel url and the run id. The run's token goes to the container's stdin as one line, and stdin is then closed, so `docker inspect` never shows it. The job, the meeting link among it, travels over the command channel.

**The command channel.** The bot opens `<channel url>` with `Authorization: Bearer <its run's token>`. A token no live run holds gets `401`, and a second channel for one run is closed with `4409`. The job is the channel's first message on every channel the bot opens, so a bot that reconnects after a restart picks up where it was; a leave taken while it was away goes down its next channel. Each run's reports go to its report url one at a time, in the order they came, under `Authorization: Bearer <run token>`. A post is tried three times with a 10-second timeout each, and a `4xx` answer other than `429` is not tried again.

**The identity pool.** Google Meet joins as a signed-in identity: each identity is a folder under `MEETING_PROFILES_ROOT` holding its browser profile, mounted read-write at `/home/bot/profile`. A run takes the first folder, in name order, that holds a `provisioned` file, holds no `needs_reauth` file, and no live run holds: one run per identity. A bot that finds its identity signed out reports the error `needs_reauth`, and the scheduler writes `needs_reauth` in that folder, so the identity leaves the pool until it is signed in again. Microsoft Teams joins as a guest with no profile.

**Restarts.** With `MEETING_STATE_ROOT`, each run's material (its job, its token, its report url, its start time, its report sequence) is written to `<run id>.json` (mode `0600`) as it changes, and deleted with the run. At start the scheduler takes back every run whose state file and container it finds and watches the container's exit again. A container of this worker with no state file is stopped and removed. A state file whose container is gone is reported `crashed`.

**Ends and kills.** A container's exit is reported `done` (exit code 0) or `crashed`, unless the bot reported its own end first. A run told to leave that has not exited 30 seconds later, a bot that has not opened its channel two minutes after its start, and a run a minute past its whole length are killed, and the exit reports each as `crashed`. A dispatch sent again with the run's token answers the run it started; one with a new token replaces the earlier container, and nothing is reported for that container.

## The bot image

`image/` builds the container the scheduler starts for each run, from this folder (`docker build -f image/Dockerfile .`), since the bot shares `src/protocol.ts` with the scheduler: Debian 12 with Node 24, Chromium through Playwright 1.63.0, PulseAudio, Xvfb, `@livekit/rtc-node`, and the bot program in `image/src/`. One container is one run.

- **Start.** `entrypoint.sh` starts PulseAudio on `image/pulse/default.pa` alone: a null sink `meeting`, the browser's output, whose monitor the bot publishes, and a null sink `silence`, whose monitor is the browser's microphone. The root file system is read-only, so PulseAudio's runtime and state folders and its cookie are made under the `/run/pulse` tmpfs as the bot user, and Chromium's config folder (`XDG_CONFIG_HOME`), where its crash handler keeps its database and without which the browser does not start, is `/tmp/.config` in the `/tmp` tmpfs. Then Xvfb on display `:99`, then `bot.js`, which reads the run's token from stdin and opens the command channel at `MEETING_CHANNEL_URL` with it.
- **The run.** The job is the channel's first message. The bot joins the run's LiveKit room without publishing, launches Chromium on the identity's profile at `/home/bot/profile` when the run has one (a Google Meet identity from the pool) or on a fresh profile, and drives the platform's adapter: it reports `joining`, `waiting_room` and `in_call`, posts the notice, reads it back from the chat panel and reports `notice_posted`, then reads the panel every second. A `monitor_heartbeat` goes every ten seconds, and only while the panel was read through in the last ten seconds.
- **The audio.** The call's audio is published into the room only on `startCapture`: a 48 kHz mono microphone track read from the `meeting` monitor with `parec`, with nothing written to disk. Thirty seconds without a good read of the chat suspend the track inside the container, whatever the manager's clock says, and `startCapture` is refused while the read is that stale, before the notice's chat has been read, or while the bot is leaving.
- **The chat and the stop.** Each message the bot did not post itself is reported as `chat_message`. A message that holds the stop phrase is also reported as `stop_command`, and the bot leaves on it at once with "Leaving now; everything I took is being deleted.". The bot's own posts, the notice that names the stop phrase among them, are never reported.
- **The limits.** The bot leaves when the waiting room's limit passes (`not_admitted`), when the client's participant count shows nobody else for the alone limit (`alone`), and at the run's whole length (`cap`); the manager's clock is the backstop. A count the client does not show is unknown, never zero. The bot reports `participant_joined` and `participant_left` when the count changes, and `usage` once a minute.
- **Leaving.** On `leave` the bot suspends the track, posts its farewell, presses Leave, reports `left` with the reason and `done` with the seconds since its start, and exits with code 0. On `kill` it exits at once. A browser or a page that dies under the bot, a step that fails or a signed-out identity ends the run at once: the bot reports `left` (`crashed`) and `crashed` with its exit code, and exits with that code.
- **The network.** Chromium runs with service workers blocked, since a service worker's requests pass Playwright's routing by, and a route on every request: `https` only, no address literal as a host, the page's top-level document on the platform's join hosts alone, and every other request, a frame's document included, on the platform's hosts. Blocked requests are counted by host and reported once at the end, as the error `network_blocked: <host>x<count>,...`. WebSocket and media connections are the worker's firewall's.
- **Errors.** An error report carries a phase and a content-free code (`join: join_control_missing`, `browser: TimeoutError`), never a library's message, which can quote the meeting's link or a page's text. A signed-in Google Meet identity that Google signed out or challenges reports `needs_reauth` before it asks to join, and the scheduler takes it out of the pool.
- **The sandbox.** Chromium runs without its own sandbox, which needs user namespaces that the container's dropped capabilities and seccomp profile refuse; the container is the boundary. `image/seccomp.json` is Docker's default seccomp profile, unchanged (`seccomp/default.json` of moby/profiles at `6fe7deb1`); the scheduler sends it with each container when `MEETING_SECCOMP_PROFILE` names it.
- **Logs.** The bot writes JSON lines through pino, each with the run's id: events, phases, reasons, codes and counts, never a link, a name or a chat line.

**The adapters.** `image/src/adapters/google-meet.ts` and `microsoft-teams.ts` each hold a selector table and a `selectorsVersion`, the date its selectors were last read against the live client, and the hosts the client may load. Every selector is one Playwright engine: CSS, a comma list included, or one `text=` selector. Their checks read what is visible, a read waits two seconds at most for its element, and the chat is read only while its panel is open. `fixture.ts` runs the adapter of the platform the link's `platform` parameter names against the test fixture page, whose markup carries that platform's selectors; the bot takes it only for a job marked `adapter: 'fixture'`, and its network policy admits the fixture's own host alone, over plain `http` too.

## Tests

`test/provider.spec.ts` runs the provider against a stubbed `fetch`: the declaration, the join-link checks, dispatch and the `409`, report verification and parsing, commands, deletion and its refusals, and usage. `test/protocol.spec.ts` parses each channel message, refuses an unknown report event and checks the event ids. `test/scheduler.spec.ts` runs the scheduler on an ephemeral port with a fake Docker (`test/fakes/docker.ts`), a fake product that records every report (`test/fakes/product.ts`) and real `ws` sockets: the credential, the slots and the container policy, the join-link checks, the channel's job, commands and reports, a second channel, exits, the bot's own end, restarts and stray containers, the kills, capacity and pausing, the fixture host, a dispatch sent again, deletion, a leave taken while the bot was away, report order and retries, the identity pool, refused bodies, start failures and the listen addresses. `image/src/__tests__/adapters.test.ts` checks the bot's adapters with no browser: every selector in the Google Meet and Microsoft Teams tables is one Playwright engine, the network policy's rule on each platform's hosts, schemes and address literals, and the fixture adapter's platform, code and hosts. `image/src/__tests__/audio.test.ts` runs the audio publisher against fakes of `@livekit/rtc-node` and `parec` whose publish waits until the test answers it: two starts at once publish one track and start one capture, and a suspend that comes while a start waits stops the track and the capture that start began. CI runs all five with the pack's tests.

**The lifecycle test.** `image/fixture/` is a meeting page that carries the Google Meet adapter's selectors: a pre-join screen (the name field, the camera and microphone toggles, Ask to join), a waiting screen, the call's tiles, the participant count, the chat panel and the Leave key, and an `<audio>` element that plays a known recording into the page's output, which is the call's audio. With `platform=microsoft_teams` in its link it carries the Microsoft Teams adapter's selectors instead, and draws the Teams chat as open-source Teams clients read it: a message card (`[data-tid="chat-pane-message"]`) holds its author, its time and its body (`[data-tid="messageBodyContent"]`), and the composer is CKEditor's editable inside `[data-tid="ckeditor"]`, or that element itself with `composer=self`, the two shapes Teams builds show. Its server, `serve.mjs` on port 8787, queues scripted events from `POST /control` (`admit`, `late_joiner`, `chat` with a sender and a text, and `noId` for a Meet message drawn without `data-message-id`, `hide_chat`, `show_chat`, `leave_all`) for the page to poll, and keeps what the page did on `GET /state`: its knocks, the texts the bot posted, its presses of Leave. The recording is spoken from `recording.txt` by espeak-ng when the fixture's image is built: about twenty seconds of 16 kHz mono speech. `image/test/compose.yml` runs LiveKit 1.13.7 in development mode (its documented key pair, `devkey` and `secret`), the fixture, a fake product that records every report with a hash of the token it came under, and the scheduler on this pack's build, which starts real bot containers from `agentos-meeting-bot:ci` on the `meeting-bots` network under its fixed container policy, the seccomp profile included. `image/test/lifecycle.mjs` sends five runs through the scheduler's API and listens to each run's room with `@livekit/rtc-node`:

- The first run joins, waits in the waiting room, is admitted, posts the notice, reads it back and reports a heartbeat within 12 seconds of it. No audio frame reaches the room before `startCapture`.
- After `startCapture` the recording is heard in the room: above 0.01 RMS in at least three of five seconds, the first frame after `notice_posted`.
- With the chat panel hidden the heartbeats stop, the bot suspends its own capture within 45 seconds and the audio stops. With the panel shown the heartbeats come back and the capture starts again.
- A late joiner is reported as `participant_joined`, and the short notice is posted.
- A participant's stop phrase is reported as `chat_message` and `stop_command`. The bot posts "Leaving now; everything I took is being deleted.", presses Leave, and reports `left` (`stopped_by_participant`) and `done`. No audio reaches the room after `left`, and the container is removed.
- A second run, admitted and confirmed but never sent `startCapture`, publishes no track for 15 seconds, then leaves on the `leave` command with its reason.
- A third run, sent two `startCapture` commands at once, publishes one track. The same short message sent twice by messages without a `data-message-id` gives two `chat_message` reports, and the stop phrase from a participant whose name is You is obeyed.
- A Microsoft Teams run with the chat's editable inside `[data-tid="ckeditor"]`, and another with that element itself as the editable, each post the notice and read it back, report the same short message sent twice as two `chat_message` reports, report each message as its body with its author, and leave on the stop phrase.
- `docker inspect` of each live container shows neither its meeting link nor a token, and shows no bind mount, the browser profile in a tmpfs, a read-only root, no capabilities and the seccomp profile.
- Every report reaches the product under its run's token.

Each step prints one line. The first failed check of the first two runs and of the last two checks prints the reports received so far, by sequence number, event and time, and exits 1. The third run and the two Teams runs go on past a failed check where their run allows, and the test then fails at its end naming every check of theirs that failed. From this folder, once the pack is built:

```bash
docker build -f image/Dockerfile -t agentos-meeting-bot:ci .
openssl rand -hex 24 > image/test/client-token.txt
docker compose -f image/test/compose.yml up -d --build
npm install --prefix image/test --no-audit --no-fund
node image/test/lifecycle.mjs
docker compose -f image/test/compose.yml down -v
```

## The image, the nightly check and the measurement in CI

**The bot image** ([`meeting-bot-image.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/meeting-bot-image.yml), "Meeting bot image") runs on every pull request that touches this folder. It builds the pack, checks that `image/seccomp.json` is byte for byte `seccomp/default.json` of moby/profiles at `6fe7deb1` and prints its sha256, builds the bot image, starts its Chromium under the scheduler's container policy with the image's own entrypoint and `image/test/browser-smoke.mjs` in the bot program's place (it prints Playwright's own error when the browser does not start, which the bot's content-free log does not), and runs the lifecycle test above against the compose stack. A push to `master` that touches this folder also pushes the image to GHCR as `ghcr.io/framerslab/agentos-meeting-bot:<version>`, the version this folder's `package.json` holds at that commit, and as `:sha-<commit>`, and prints the pushed digest. The push runs in a job of its own, the only one in the workflow that can write packages: it loads the image the test ran against, while the build and the test, which install dependencies and run their scripts, hold a read-only token. The version pull request's merge changes that `package.json`, so the released version's image is pushed by that merge. The image's dependencies are installed from `image/package-lock.json`; a branch without one gets one resolved by the workflow and offered as the artifact `image-lock`, to commit.

**The nightly real-join check** ([`nightly-real-join.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/nightly-real-join.yml), daily at 03:17 UTC and by hand) joins meetings it makes in the team's own tenants, so no one else's meeting is touched. `image/test/nightly/create-meetings.mjs` makes a Google Calendar event with a Meet on a host user's calendar with the bot's identity invited (a service account with domain-wide delegation for the Calendar events scope) and a Microsoft Teams meeting for an organiser user that lets everyone past its lobby, since no person attends it (an app registration with the application permission `OnlineMeetings.ReadWrite.All` and an application access policy granted for that user). `image/test/nightly/real-join.mjs` refuses a Meet whose organiser is not the host user and a Teams link outside the team's tenant, sends the bot to each through the worker's scheduler, sends `startCapture` after the notice and a heartbeat and `leave` after a usage report, and writes per platform to `image/test/nightly/outcome.json` whether the bot was admitted, posted its notice, was heard (its capture started and a usage report followed) and left, with the seconds from its joining report to each. The run fails when a platform did not reach `in_call` or `notice_posted`; three failed nights in a row for one platform are the signal to pause it with the meeting manager's `pausePlatform` until a check passes. Both meetings are removed at the end. The scheduler posts the check's reports to a report sink beside it on the worker, `http://127.0.0.1:8789/report`, which serves a run's reports as a JSON array on `GET <scheduler url>/sink/<run id>` behind the scheduler's client credential. The check reads these repository secrets by name and skips, naming the missing ones, until they are set:

| Secret | What it is |
|---|---|
| `MEETING_SCHEDULER_URL`, `MEETING_SCHEDULER_TOKEN` | the worker's scheduler and its client credential |
| `MEET_CALENDAR_SA_JSON`, `MEET_HOST_USER`, `MEET_BOT_IDENTITY` | the service account's key, the user whose calendar hosts the Meet, the bot identity's address |
| `TEAMS_GRAPH_TENANT_ID`, `TEAMS_GRAPH_CLIENT_ID`, `TEAMS_GRAPH_CLIENT_SECRET`, `TEAMS_ORGANIZER_USER_ID` | the app registration and the user the Teams meeting is made for |
| `NIGHTLY_LIVEKIT_URL`, `NIGHTLY_LIVEKIT_API_KEY`, `NIGHTLY_LIVEKIT_API_SECRET` | the LiveKit server the bots publish into, as the worker reaches it, and its key pair |

**The measurement** ([`measure-meeting-bots.yml`](https://github.com/framerslab/agentos-extensions/blob/master/.github/workflows/measure-meeting-bots.yml), "Measure meeting bots", by hand with `concurrency`, `minutes` and the transcriber's `price_per_min`) measures a worker's capacity on the worker itself. Over SSH (the secrets `WORKER_HOST` and `WORKER_SSH_KEY`) it copies the fixture, the seccomp profile and `image/test/measure/` to `/srv/meeting/measure` and runs `measure.sh` as the worker's `bots` user. That starts a stack of its own on the bots' network: LiveKit 1.13.7 with a key pair made for the run, one fixture per bot, and a scheduler of the newest published version of this pack with those fixtures as its test hosts, which starts the bots from the published image of that version. `measure-listen.mjs` sends each bot to its fixture, admits it, sends `startCapture` after the notice and a heartbeat, and listens to each run's room with AgentOS's `startListenSession` on `LiveKitStreamTransport` at 16 kHz with `DeepgramStreamingSTT` (its key read from `/srv/meeting/secrets/deepgram` on the worker). After the given minutes it writes `measurement.json`, the workflow's artifact `measurement`: each bot's memory and CPU (median and peak over the window, from `docker stats` every 15 seconds), the LiveKit server's, the harness's and the scheduler's load (also per concurrent run), the seconds sent to the transcriber and their cost at the given price, the word error rate of each run's transcript against `recording.txt` (a token-level edit distance against the looping recording), and the slots the worker carries with the bots at their peak under 70 percent of its CPU and memory. While it runs, the bots reach the stack's containers on the bridge: the fixtures on 8787, LiveKit on 7880, 7881 and 7882/udp, and the scheduler's channel on 8798. Neither runs on a pull request or a push: the nightly check runs on its schedule or by hand, the measurement by hand only.

## License

Apache-2.0
