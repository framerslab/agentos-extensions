# Clearbit enrichment

This pack gives an agent company lookups by domain and person lookups by email through the Clearbit Enrichment REST API.

## Installation

```bash
npm install @framers/agentos-ext-clearbit
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-clearbit',
        options: { clearbitApiKey: process.env.CLEARBIT_API_KEY },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `clearbitApiKey` | `clearbit.apiKey` | `CLEARBIT_API_KEY` | Yes | Empty string in the service |
| `priority` | None | None | No | `50` |

The API key resolves from `clearbitApiKey`, then `getSecret('clearbit.apiKey')`, then `CLEARBIT_API_KEY`. Tool descriptors declare `clearbit.apiKey` as a required secret.

## Tools

| Tool | What it does |
| --- | --- |
| `clearbit_company` | Looks up company information by web domain through Clearbit. |
| `clearbit_person` | Looks up person information by email address through Clearbit. |

### `clearbit_company`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | `string` | Yes | Company web domain to look up (e.g. "stripe.com"). |

### `clearbit_person`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `string` | Yes | Email address of the person to look up. |

## Notes

Lookups send authenticated GET requests using Bearer authentication. They return `null` for a record that is not found and return tool errors for rejected input, network failures, and other API failures. Both tools declare `capability:data_enrichment` and have no write side effects.

The factory does not reject a missing API key. The service falls back to an empty string and sends that value in its authorization header.

## License

Apache-2.0
