# Twilio voice calls

This pack gives an agent a voice call provider and a call management tool interface using the `twilio` SDK, Twilio REST API and TwiML. The provider creates calls, generates speech instructions and parses call status webhooks.

## Installation

```bash
npm install @framers/agentos-ext-voice-twilio
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-voice-twilio';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
    webhookBaseUrl: process.env.TWILIO_WEBHOOK_BASE_URL,
  },
  logger: console,
}));
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

The factory registers the tool with a placeholder handler: initiating, speaking and ending calls return handler-not-configured errors; status lookup finds no call, and listing returns an empty array. Although comments mention `setToolHandler`, the source exports no such function. The exported `VoiceCallTool` constructor accepts a host-provided `VoiceCallToolHandler` for separate construction.

With a configured handler, call operations have side effects. Runtime checks require `toNumber` for `initiate_call`, `callId` and `message` for `speak`, and `callId` for `end_call`. Despite its schema description, `get_status` accepts no `callId` to list active calls. The tool passes an omitted `mode` through to the handler without applying a default. Number validation checks for a string beginning with `+`.

The provider generates notify TwiML with speech followed by hangup, defaulting to `Polly.Joanna`. Its `playTts` method uses the same speech-and-hangup TwiML. Conversation TwiML connects a media stream when the caller supplies a stream URL. The service escapes XML values.

Webhook verification uses the request URL, body parameters and auth token. Missing signatures or invalid signatures are rejected. Form-encoded status callbacks map to normalized call events. The pack registers `voice-provider` named `twilio`; its files do not start webhook or media socket servers.

## License

Apache-2.0
