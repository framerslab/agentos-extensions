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
- **Deletion.** `deleteRun` calls `DELETE /runs/:id` and answers `{ deleted: false }`: the provider keeps no copy of a run.
- **Reports.** The scheduler posts each report to the run's report url as a `ReportPost` under `Authorization: Bearer <worker token>`. `verifyEvent` accepts a report whose bearer token hashes to the run's `dispatch.workerTokenHash`. `parseEvent` returns one event whose id is `browser:<run>:<seq>:<event>`, so a report delivered twice keeps one id.

Every request to the scheduler carries `Authorization: Bearer <schedulerToken>` and follows no redirect.

The provider declares itself a participant that posts and reads the chat, publishes the call's audio into the run's LiveKit room, records and transcribes nothing, keeps nothing, and leaves on the stop phrase in the chat: `{ joinsAsParticipant: true, postsChat: true, readsChat: true, audioPath: 'livekit_room', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'chat' }`.

## The protocol

`src/protocol.ts` holds the zod schemas of the messages between the scheduler and a bot container (`JobMessage`, `CommandMessage`, `AckMessage`, `ReportMessage` and their union `ChannelMessage`) and of the scheduler's HTTP API (`StartRunRequest`, `ReportPost`, `RunStatus`, `Capacity`), with `reportEventId`. The package root exports them all.

## Tests

`test/provider.spec.ts` runs the provider against a stubbed `fetch`: the declaration, the join-link checks, dispatch and the `409`, report verification and parsing, commands, deletion and usage. `test/protocol.spec.ts` parses each channel message, refuses an unknown report event and checks the event ids. CI runs both.

## License

Apache-2.0
