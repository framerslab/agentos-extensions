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

## Tests

`test/provider.spec.ts` runs the provider against a stubbed `fetch`: the declaration, the join-link checks, dispatch and the `409`, report verification and parsing, commands, deletion and its refusals, and usage. `test/protocol.spec.ts` parses each channel message, refuses an unknown report event and checks the event ids. `test/scheduler.spec.ts` runs the scheduler on an ephemeral port with a fake Docker (`test/fakes/docker.ts`), a fake product that records every report (`test/fakes/product.ts`) and real `ws` sockets: the credential, the slots and the container policy, the join-link checks, the channel's job, commands and reports, a second channel, exits, the bot's own end, restarts and stray containers, the kills, capacity and pausing, the fixture host, a dispatch sent again, deletion, a leave taken while the bot was away, report order and retries, the identity pool, refused bodies, start failures and the listen addresses. CI runs all three.

## License

Apache-2.0
