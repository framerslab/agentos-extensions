# Namecheap domain registrar

This pack gives an agent domain availability checks, registration, account listings and DNS host record management through the Namecheap XML API.

## Installation

```bash
npm install @framers/agentos-ext-domain-namecheap
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-domain-namecheap';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    apiUser: process.env.NAMECHEAP_API_USER,
    apiKey: process.env.NAMECHEAP_API_KEY,
    userName: process.env.NAMECHEAP_USERNAME,
    clientIp: process.env.NAMECHEAP_CLIENT_IP,
    useSandbox: process.env.NAMECHEAP_SANDBOX === 'true',
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiUser` | `namecheap.apiUser` | `NAMECHEAP_API_USER` | Yes | Empty string |
| `apiKey` | `namecheap.apiKey` | `NAMECHEAP_API_KEY` | Yes | Empty string |
| `userName` | `namecheap.userName` | `NAMECHEAP_USERNAME` | No | `apiUser` |
| `clientIp` | `namecheap.clientIp` | `NAMECHEAP_CLIENT_IP` | Yes | Empty string |
| `useSandbox` | | `NAMECHEAP_SANDBOX` | No | `false` |
| `secrets` | | | No | Context `secrets`, then `{}` |
| `baseUrl` (service constructor only) | | | No | `https://api.namecheap.com/xml.response`, or `https://api.sandbox.namecheap.com/xml.response` when `useSandbox` is true |

Credentials resolve from options, then the selected secrets map, then environment variables. The sandbox environment variable enables the sandbox only when it equals `true`. The factory does not pass `baseUrl` to the service.

## Tools

| Tool | What it does |
| --- | --- |
| `namecheapSearchDomain` | Checks comma-separated domain names for availability and premium pricing. |
| `namecheapRegisterDomain` | Purchases a domain with registrant contacts, WhoisGuard and nameserver options. |
| `namecheapListDomains` | Lists account domains with creation, expiry, lock, renewal and WhoisGuard status. |
| `namecheapConfigureDns` | Sets DNS host records, replacing all existing records for the domain. |
| `namecheapGetDnsRecords` | Retrieves DNS host records with values, TTL, MX priority and active status. |

### `namecheapSearchDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domains` | string | Yes | Comma-separated list of domains to check (e.g. "example.com,example.net,example.io") |

### `namecheapRegisterDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domainName` | string | Yes | The domain to register (e.g. "example.com") |
| `years` | number | No | Number of years to register (1-10, default: 1) |
| `registrant` | object | Yes | Registrant contact info with: `firstName`, `lastName`, `address1`, `city`, `stateProvince`, `postalCode`, `country`, `phone`, `emailAddress`. Optional: `organizationName`, `address2`. |
| `registrant.firstName` | string | Yes, within `registrant` | |
| `registrant.lastName` | string | Yes, within `registrant` | |
| `registrant.address1` | string | Yes, within `registrant` | |
| `registrant.city` | string | Yes, within `registrant` | |
| `registrant.stateProvince` | string | Yes, within `registrant` | |
| `registrant.postalCode` | string | Yes, within `registrant` | |
| `registrant.country` | string | Yes, within `registrant` | `2`-letter country code (e.g. "US", "GB") |
| `registrant.phone` | string | Yes, within `registrant` | Phone in +CountryCode format (e.g. "+1.5555555555") |
| `registrant.emailAddress` | string | Yes, within `registrant` | |
| `registrant.organizationName` | string | No | |
| `registrant.address2` | string | No | |
| `tech` | object | No | Tech contact (same shape as `registrant`, defaults to `registrant`) |
| `admin` | object | No | Admin contact (same shape as `registrant`, defaults to `registrant`) |
| `auxBilling` | object | No | AuxBilling contact (same shape as `registrant`, defaults to `registrant`) |
| `addFreeWhoisguard` | boolean | No | Enable WhoisGuard privacy (default: true) |
| `wgEnabled` | boolean | No | Activate WhoisGuard (default: true) |
| `nameservers` | string | No | Custom nameservers, comma-separated (uses Namecheap defaults if omitted) |

### `namecheapListDomains`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pageSize` | number | No | Number of domains per page (default: 20, max: 100) |
| `page` | number | No | Page number to retrieve (default: 1) |

### `namecheapConfigureDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | Fully-qualified domain name (e.g. "example.com") |
| `records` | array of objects | Yes | Array of DNS records to set. Each record needs: `hostName` (e.g. "@", "www"), `recordType` (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `URL`, `URL301`, `FRAME`), `address` (value). Optional: `mxPref` (default "10"), `ttl` (default "1800"). |
| `records[].hostName` | string | Yes, within each record | Hostname (e.g. "@" for root, "www", "mail", "*" for wildcard) |
| `records[].recordType` | string, enum: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `URL`, `URL301`, `FRAME` | Yes, within each record | DNS record type |
| `records[].address` | string | Yes, within each record | Record value (IP address, hostname, or text content) |
| `records[].mxPref` | string | No | MX preference/priority (default "10", only for MX records) |
| `records[].ttl` | string | No | Time to live in seconds (default "1800") |

### `namecheapGetDnsRecords`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | Fully-qualified domain name (e.g. "example.com") |

## Notes

Activation rejects missing `apiUser`, `apiKey` or `clientIp` and checks credentials by listing domains. The client IP must be whitelisted in the Namecheap dashboard. Requests use GET with authentication and command parameters in the URL.

Registration charges the account balance. Technical, admin and billing contacts default to `registrant`. WhoisGuard settings default to enabled.

DNS configuration replaces all existing records and rejects an empty `records` array. Retrieve records with `namecheapGetDnsRecords` and include the records to retain in the replacement set. The listing tool forwards pagination values without enforcing the schema description's maximum. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
