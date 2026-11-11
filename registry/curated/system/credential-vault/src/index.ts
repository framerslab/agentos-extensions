// @ts-nocheck
/**
 * @fileoverview Credential Vault Extension for AgentOS.
 *
 * Provides 5 tools for encrypted credential management — store, retrieve,
 * list, rotate, and import credentials using AES-256-GCM encryption.
 *
 * @module @framers/agentos-ext-credential-vault
 */

import { CredentialVaultService } from './CredentialVaultService.js';
import { CredentialsSetTool } from './tools/set.js';
import { CredentialsGetTool } from './tools/get.js';
import { CredentialsListTool } from './tools/list.js';
import { CredentialsRotateTool } from './tools/rotate.js';
import { CredentialsImportTool } from './tools/import.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CredentialVaultOptions {
  passphrase?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolvePassphrase(opts: CredentialVaultOptions, secrets: Record<string, string>): string {
  return (
    opts.passphrase ??
    secrets['credential-vault.passphrase'] ??
    process.env.CREDENTIAL_VAULT_PASSPHRASE ??
    'agentos-default-vault-passphrase'
  );
}

// ---------------------------------------------------------------------------
// Extension Context (matches AgentOS extension protocol)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options ?? {}) as CredentialVaultOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const passphrase = resolvePassphrase(opts, secrets);

  const service = new CredentialVaultService(passphrase);

  const setTool = new CredentialsSetTool(service);
  const getTool = new CredentialsGetTool(service);
  const listTool = new CredentialsListTool(service);
  const rotateTool = new CredentialsRotateTool(service);
  const importTool = new CredentialsImportTool(service);

  return {
    name: '@framers/agentos-ext-credential-vault',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'credentialsSet', kind: 'tool', priority: 50, payload: setTool },
      { id: 'credentialsGet', kind: 'tool', priority: 50, payload: getTool },
      { id: 'credentialsList', kind: 'tool', priority: 50, payload: listTool },
      { id: 'credentialsRotate', kind: 'tool', priority: 50, payload: rotateTool },
      { id: 'credentialsImport', kind: 'tool', priority: 50, payload: importTool },
    ],
    onActivate: async () => {
      await service.initialize();
    },
    onDeactivate: async () => {
      await service.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { CredentialVaultService } from './CredentialVaultService.js';
export type { CredentialEntry, CredentialInfo, ImportResult } from './CredentialVaultService.js';
export { CredentialsSetTool } from './tools/set.js';
export { CredentialsGetTool } from './tools/get.js';
export { CredentialsListTool } from './tools/list.js';
export { CredentialsRotateTool } from './tools/rotate.js';
export { CredentialsImportTool } from './tools/import.js';
