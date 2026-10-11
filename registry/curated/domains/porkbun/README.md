# Porkbun domain registrar

This pack gives an agent domain availability checks, purchases, account listings, DNS management and transfers through the Porkbun REST API.

## Installation

```bash
npm install @framers/agentos-ext-domain-porkbun
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-domain-porkbun',
        options: {
          apiKey: process.env.PORKBUN_API_KEY,
          secretApiKey: process.env.PORKBUN_SECRET_API_KEY,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` | `porkbun.apiKey` | `PORKBUN_API_KEY` | Yes | Empty string |
| `secretApiKey` | `porkbun.secretApiKey` | `PORKBUN_SECRET_API_KEY` | Yes | Empty string |
| `secrets` | | | No | Context `secrets`, then `{}` |
| `baseUrl` (service constructor only) | | | No | `https://api.porkbun.com/api/json/v3` |

Credentials resolve from options, then the selected secrets map, then environment variables. The factory does not pass `baseUrl` to the service.

## Tools

| Tool | What it does |
| --- | --- |
| `porkbunSearchDomain` | Checks domain availability and retrieves pricing. |
| `porkbunRegisterDomain` | Purchases a domain using supplied contacts or account defaults. |
| `porkbunListDomains` | Lists account domains with dates, status, lock, privacy and renewal settings. |
| `porkbunConfigureDns` | Adds, removes, lists or updates DNS records. |
| `porkbunTransferDomain` | Initiates a transfer to Porkbun using an authorization code. |

### `porkbunSearchDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to check (e.g. "example.com", "coolsite.dev") |

### `porkbunRegisterDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to register (e.g. "example.com") |
| `years` | number | No | Number of years to register (default: 1, max: 10) |
| `firstName` | string | No | Registrant first name (uses account default if omitted) |
| `lastName` | string | No | Registrant last name (uses account default if omitted) |
| `email` | string | No | Registrant email (uses account default if omitted) |
| `phone` | string | No | Registrant phone number (uses account default if omitted) |
| `city` | string | No | Registrant city (uses account default if omitted) |
| `state` | string | No | Registrant state/province (uses account default if omitted) |
| `zip` | string | No | Registrant postal code (uses account default if omitted) |
| `country` | string | No | Registrant country code, e.g. "US" (uses account default if omitted) |
| `organization` | string | No | Registrant organization (optional) |
| `address` | string | No | Registrant street address (uses account default if omitted) |

### `porkbunListDomains`

The input schema has no parameters.

### `porkbunConfigureDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name (e.g. "example.com") |
| `action` | string, enum: `add`, `remove`, `list`, `update` | No | Action to perform (default: list) |
| `recordId` | string | No | The DNS record ID (required for remove and update actions) |
| `type` | string, enum: `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `TLSA`, `CAA`, `ALIAS` | No | DNS record type (required for add action) |
| `name` | string | No | Subdomain or record name (e.g. "www", "mail"). Empty string or omit for root domain. |
| `content` | string | No | Record value/content (e.g. IP address, hostname, TXT value) |
| `ttl` | string | No | Time to live in seconds (default: "300") |
| `prio` | string | No | Priority (required for MX records, optional for others) |

### `porkbunTransferDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to transfer (e.g. "example.com") |
| `authCode` | string | Yes | The authorization/EPP code from the current registrar (required to authorize the transfer) |

## Notes

Activation rejects missing credentials and authenticates through the API ping endpoint. API keys come from `https://porkbun.com/account/api`. Requests use POST with `apikey` and `secretapikey` in the body.

Registration charges the payment method on file. Contact fields use account defaults when omitted. Transfers submit the domain and authorization code; the tool description requires the domain to be unlocked at the previous registrar.

DNS changes create, edit or delete records. Addition requires `type` and `content`; removal and update require `recordId`. An update retrieves records afterward and returns the matching record, or the full list when no match is found. Pricing lookup failures leave pricing absent from availability results. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
