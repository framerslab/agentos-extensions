# Credential vault

This pack gives an agent tools to store, retrieve, list, rotate, and import credentials scoped by platform and key. It uses Node.js `crypto` for `AES-256-GCM` encryption and keeps credentials in memory.

## Installation

```bash
npm install @framers/agentos-ext-credential-vault
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-credential-vault',
        options: {
          passphrase: process.env.CREDENTIAL_VAULT_PASSPHRASE,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `passphrase` | `credential-vault.passphrase` | `CREDENTIAL_VAULT_PASSPHRASE` | No | `agentos-default-vault-passphrase` |
| `secrets` | None | None | No | Context `secrets`, then `{}` |

Passphrase resolution checks `options.passphrase`, the selected secrets map's `credential-vault.passphrase`, and `CREDENTIAL_VAULT_PASSPHRASE`, then uses the default. `options.secrets` takes precedence over context `secrets`; the maps are not merged. Resolution uses nullish coalescing, so an empty string passphrase is accepted.

## Tools

| Tool | What it does |
| --- | --- |
| `credentialsSet` | Stores an encrypted credential scoped by platform and key. |
| `credentialsGet` | Retrieves a decrypted credential by platform and key. |
| `credentialsList` | Lists credentials with masked values, optionally filtered by platform. |
| `credentialsRotate` | Replaces an existing credential's value and returns a rotation timestamp. |
| `credentialsImport` | Imports credentials from JSON or CSV data into the encrypted vault. |

### `credentialsSet`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `string` | Yes | Platform or service name (e.g., "twitter", "openai", "github") |
| `key` | `string` | Yes | Credential key (e.g., `apiKey`, `accessToken`, `password`) |
| `value` | `string` | Yes | Credential value to encrypt and store |

### `credentialsGet`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `string` | Yes | Platform or service name (e.g., "twitter", "openai") |
| `key` | `string` | Yes | Credential key (e.g., `apiKey`, `accessToken`) |

### `credentialsList`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `string` | No | Optional platform filter to list credentials for a specific service |

### `credentialsRotate`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | `string` | Yes | Platform or service name |
| `key` | `string` | Yes | Credential key to rotate |
| `refreshToken` | `string` | Yes | New credential value or refresh token |

### `credentialsImport`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `string` | Yes | Credential data as JSON array (e.g., `[{"platform":"x","key":"apiKey","value":"sk-..."}]`) or CSV (`platform,key,value` per line) |
| `format` | `string`, enum: `json`, `csv` | No | Data format (default: `json`) |

## Notes

- Activation initializes the vault. Before activation and after deactivation, tools return `success: false` with "CredentialVaultService not initialized". Deactivation clears stored credentials.
- The passphrase derives the encryption key through `scryptSync` with the fixed salt `agentos-credential-vault-salt`. Each stored value uses a random initialization vector. Missing passphrase configuration uses the default shown above.
- Setting or importing an existing platform and key overwrites its value, preserves `createdAt`, and updates `updatedAt`.
- `credentialsGet` returns the plaintext value in `data.value`. A missing credential returns `success: false`. Listing returns masked values and timestamps sorted by platform and key; masked values can reveal a prefix.
- `credentialsRotate` requires an existing credential and stores `refreshToken` as its new value. It returns `rotatedAt` in its result but does not write that timestamp to the stored entry. It makes no external token refresh request.
- JSON import accepts an array or an object with `platform`, `key`, and `value`. Entries with missing or empty fields are skipped and reported as errors.
- CSV import reads `platform`, `key`, and `value` from each line, trims those values, ignores blank lines, and skips the first nonblank line if it contains "platform", ignoring case. Its line parser handles quoted commas and escaped double quotes.
- Import results report `imported`, `skipped`, and any `errors`. Parse errors and skipped entries can appear in a result with `success: true`.
- The exported `CredentialVaultService` also exposes `deleteCredential` and `exportCredentials`. Export returns plaintext values. The pack registers no delete or export tool.

## License

Apache-2.0
