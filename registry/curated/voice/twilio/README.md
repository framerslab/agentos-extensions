# Twilio voice calls

This pack gives an agent a voice call provider and a call management tool interface using the `twilio` SDK, Twilio REST API and TwiML. The provider creates calls, generates speech instructions and parses call status webhooks.

## Installation

```bash
npm install @framers/agentos-ext-voice-twilio
```

Peer dependency: `@framers/agentos`, at the minimum version declared by this package.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-voice-twilio',
        options: {
          accountSid: process.env.TWILIO_ACCOUNT_SID,
          authToken: process.env.TWILIO_AUTH_TOKEN,
          fromNumber: process.env.TWILIO_FROM_NUMBER,
          webhookBaseUrl: process.env.TWILIO_WEBHOOK_BASE_URL,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from direct options, then `options.secrets`, then the selected environment variable. A custom environment name replaces the default name; caller number resolution then checks its fallback.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accountSid` | `twilio.accountSid` | Name in `accountSidEnv`, otherwise `TWILIO_ACCOUNT_SID` | Yes | Empty string, then throws |
| `authToken` | `twilio.authToken` | Name in `authTokenEnv`, otherwise `TWILIO_AUTH_TOKEN` | Yes | Empty string, then throws |
| `fromNumber` | `twilio.fromNumber` | Name in `fromNumberEnv`, otherwise `TWILIO_FROM_NUMBER`; then `TWILIO_PHONE_NUMBER` | No | Empty string |
| `webhookBaseUrl` | None | `TWILIO_WEBHOOK_BASE_URL` | No | `undefined` |
| `accountSidEnv` | None | None | No | `TWILIO_ACCOUNT_SID` selected by resolver |
| `authTokenEnv` | None | None | No | `TWILIO_AUTH_TOKEN` selected by resolver |
| `fromNumberEnv` | None | None | No | `TWILIO_FROM_NUMBER` selected by resolver |
| `priority` | None | None | No | `50` |
| `secrets` | Map containing the secret ids above | None | No | `undefined` |
| `callManager` | None | None | No | Exposed pack-owned manager |

## Tools

| Tool | What it does |
| --- | --- |
| `twilioVoiceCall` | Makes or manages Twilio phone calls through a handler, including outbound calls, speech, ending calls and status queries. |

### `twilioVoiceCall` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `string`, enum: `initiate_call`, `speak`, `end_call`, `get_status` | Yes | The action to perform |
| `toNumber` | `string` | No | E.164 phone number to call (e.g., +15551234567). Required for `initiate_call`. |
| `message` | `string` | No | Text to speak. Used for `initiate_call` (notify mode) and `speak` action. |
| `callId` | `string` | No | Call ID. Required for `speak`, `end_call`, and `get_status` actions. |
| `mode` | `string`, enum: `notify`, `conversation` | No | Call mode. "`notify`" speaks a message and hangs up; "`conversation`" enables bidirectional audio. Defaults to "`conversation`". |

## Notes

The package requires Node.js `>=22`. Activation dynamically loads the SDK and initializes the service. Deactivation releases the SDK client. Missing account credentials throw during pack creation.

The factory registers the tool against its exposed manager binding. An injected manager is used immediately; otherwise the pack creates its own manager. The exported `VoiceCallTool` constructor still accepts a host-provided handler for separate construction.

With a configured handler, call operations have side effects. Runtime checks require `toNumber` for `initiate_call`, `callId` and `message` for `speak`, and `callId` for `end_call`. Despite its schema description, `get_status` accepts no `callId` to list active calls. The tool passes an omitted `mode` through to the handler without applying a default. Number validation checks for a string beginning with `+`.

The provider generates notify TwiML with speech followed by hangup, defaulting to `Polly.Joanna`. Its `playTts` method uses the same speech-and-hangup TwiML. Conversation TwiML connects a media stream when the caller supplies a stream URL. The service escapes XML values.

Webhook verification uses the request URL, body parameters and auth token. Missing signatures or invalid signatures are rejected. Form-encoded status callbacks map to normalized call events. The pack registers `voice-provider` named `twilio`; its files do not start webhook or media socket servers.

## Host call manager binding

Pass `options.callManager` to use a host-owned `CallManager`. The returned pack exposes `binding`, whose `manager`, `provider` and `toolHandler` identify the actual objects used by the call tool. `binding.setManager(next)` registers the provider on the replacement manager and changes subsequent tool operations. Rebind only after the host has drained or transferred its active calls; the binding does not migrate call state.

The voice-provider descriptor still contains the raw Twilio provider. Its read-only `binding` property exposes the same binding to an `ExtensionManager` registry consumer. The call tool's id, actions and public handler type remain compatible. When no manager is supplied, the pack creates and exposes its own; deactivation disposes only that original owned manager. An injected or replacement manager remains the host's responsibility. No call is placed during construction.

This binding does not change the pack's legacy carrier implementation or grant the durable carrier profile's event identity and webhook guarantees. Select the core carrier profile explicitly when those guarantees are required. The package's declared core peer floor is required for the binding API.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
