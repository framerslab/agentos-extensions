# Plivo voice calls

This pack gives an agent a phone call management tool and registers a voice call provider. It uses the `plivo` SDK for outbound calls, in-call speech and hangup, and parses Plivo webhooks into AgentOS call events.

## Installation

```bash
npm install @framers/agentos-ext-voice-plivo
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-voice-plivo';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    authId: process.env.PLIVO_AUTH_ID,
    authToken: process.env.PLIVO_AUTH_TOKEN,
    fromNumber: process.env.PLIVO_FROM_NUMBER ?? process.env.PLIVO_PHONE_NUMBER,
  },
  logger: console,
}));
```

Supply an existing AgentOS `CallManager` through `options.callManager` to enable the tool's call operations. The example registers the provider with the fallback tool handler.

## Configuration

Credentials resolve from a nonempty direct option, then `options.secrets`, then the selected environment variable, then the fixed fallbacks in the order shown. The manifest requires `plivo.authId` and `plivo.authToken`; the factory also requires a caller number.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `authId` | `plivo.authId` | Name selected by `authIdEnv` (default `PLIVO_AUTH_ID`), then `PLIVO_AUTH_ID` | Yes | None |
| `authToken` | `plivo.authToken` | Name selected by `authTokenEnv` (default `PLIVO_AUTH_TOKEN`), then `PLIVO_AUTH_TOKEN` | Yes | None |
| `fromNumber` | `plivo.fromNumber` | Name selected by `fromNumberEnv` (default `PLIVO_FROM_NUMBER`), then `PLIVO_FROM_NUMBER`, then `PLIVO_PHONE_NUMBER` | Yes | None |
| `authIdEnv` | None | None | No | `PLIVO_AUTH_ID` |
| `authTokenEnv` | None | None | No | `PLIVO_AUTH_TOKEN` |
| `fromNumberEnv` | None | None | No | `PLIVO_FROM_NUMBER` |
| `secrets` | `plivo.authId`, `plivo.authToken`, `plivo.fromNumber` | None | No | Unset |
| `callManager` | None | None | No | Fallback handler |
| `priority` | None | None | No | `50` |
| `logger` (context field) | None | None | No | Unset |
| No option, webhook verification | None | `NODE_ENV`, then `PLIVO_SKIP_SIGNATURE` | No | Unset |

When signature headers are missing, `NODE_ENV` equal to `development` or `PLIVO_SKIP_SIGNATURE` equal to `true` allows the webhook. These variables do not bypass a signature mismatch when headers are present.

## Tools

| Tool | What it does |
| --- | --- |
| `plivoVoiceCall` | Makes outbound calls, plays speech into calls, hangs up calls, queries call status and lists active calls. |

Parameters for `plivoVoiceCall`:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string, enum: `call`, `speak`, `hangup`, `status`, `list` | Yes | The voice call action to perform. |
| `toNumber` | string | No | E.164 phone number to call (required for "call" action). |
| `callId` | string | No | Call ID (required for "speak", "hangup", "status" actions). |
| `message` | string | No | Text to speak. For "call" in notify mode, this is the message. For "speak", this is played into the active call. |
| `mode` | string, enum: `notify`, `conversation` | No | Call mode (default: "conversation"). "notify" speaks a message and hangs up. |

The schema requires `action`. The tool's validation and execution also require `toNumber` for `call`, `callId` for `speak`, `hangup` and `status`, and `message` for `speak`.

## Notes

The package requires Node `>=22`. Plivo authentication credentials and an E.164 caller number are needed. Missing required settings cause the factory to throw an error naming the option, secret and primary environment variable.

Activation initializes the SDK client and registers the `plivo` voice provider with the supplied `CallManager`. Deactivation clears the service's client reference. Without a `CallManager`, call, speech and hangup operations return errors; status reports no matching call and list returns an empty collection.

The tool has side effects: it places calls, speaks into active calls and terminates calls. Its default call mode is `conversation`. The service's default speech voice is `Polly.Joanna`. Notify XML speaks a message then hangs up. Conversation XML uses speech input, sets `GetInput`'s `executionTimeout` to `30`, and redirects to the webhook URL. The provider generates answer XML during call initiation but does not store or serve it. The hosting application must expose a public answer endpoint that returns the XML. The answer URL appends `callId` and `mode` query parameters and uses POST.

Webhook parsing accepts a pre-parsed body, JSON or form-encoded data. A payload without `CallUUID` produces no call events. `Speech` produces a final transcript; call statuses and hangup causes map to call state events. `Digits` is declared but is not emitted as an event. Verification uses HMAC with `sha256` over the request URL plus nonce, authenticated with the resolved token.

## License

Apache-2.0
