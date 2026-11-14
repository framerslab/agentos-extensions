// @ts-nocheck
/**
 * @fileoverview Cloudflare Registrar Extension for AgentOS.
 *
 * Provides 4 tools for listing, inspecting, and managing domains and DNS
 * records via the Cloudflare API v4.
 *
 * @module @framers/agentos-ext-domain-cloudflare-registrar
 */

import { CloudflareRegistrarService } from './CloudflareRegistrarService.js';
import type { CloudflareRegistrarConfig } from './CloudflareRegistrarService.js';
import { CfRegListDomainsTool } from './tools/listDomains.js';
import { CfRegGetDomainInfoTool } from './tools/getDomainInfo.js';
import { CfRegConfigureDnsTool } from './tools/configureDns.js';
import { CfRegTransferDomainTool } from './tools/transferDomain.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CloudflareRegistrarOptions {
  apiToken?: string;
  accountId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(
  opts: CloudflareRegistrarOptions,
  secrets: Record<string, string>,
): CloudflareRegistrarConfig {
  return {
    apiToken:
      opts.apiToken ?? secrets['cloudflare.apiToken']
      ?? process.env.CLOUDFLARE_API_TOKEN ?? '',
    accountId:
      opts.accountId ?? secrets['cloudflare.accountId']
      ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  };
}

// ---------------------------------------------------------------------------
// Extension Context
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
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
  const opts = (context.options ?? {}) as CloudflareRegistrarOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new CloudflareRegistrarService(config);

  const listDomainsTool = new CfRegListDomainsTool(service);
  const getDomainInfoTool = new CfRegGetDomainInfoTool(service);
  const configureDnsTool = new CfRegConfigureDnsTool(service);
  const transferDomainTool = new CfRegTransferDomainTool(service);

  return {
    name: '@framers/agentos-ext-domain-cloudflare-registrar',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'cfRegListDomains', kind: 'tool', priority: 40, payload: listDomainsTool },
      { id: 'cfRegGetDomainInfo', kind: 'tool', priority: 40, payload: getDomainInfoTool },
      { id: 'cfRegConfigureDns', kind: 'tool', priority: 40, payload: configureDnsTool },
      { id: 'cfRegTransferDomain', kind: 'tool', priority: 40, payload: transferDomainTool },
    ],
    onActivate: async () => {
      if (!config.apiToken) {
        throw new Error(
          'Cloudflare: no API token provided. Set CLOUDFLARE_API_TOKEN environment variable, '
          + 'or provide it via secrets["cloudflare.apiToken"].',
        );
      }
      if (!config.accountId) {
        throw new Error(
          'Cloudflare: no account ID provided. Set CLOUDFLARE_ACCOUNT_ID environment variable, '
          + 'or provide it via secrets["cloudflare.accountId"].',
        );
      }
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

export { CloudflareRegistrarService } from './CloudflareRegistrarService.js';
export type {
  CloudflareRegistrarConfig,
  RegisteredDomain,
  DomainDetail,
  DomainSettingsUpdate,
  DnsRecord,
  DnsRecordInput,
  TransferDomainResult,
} from './CloudflareRegistrarService.js';
export { CfRegListDomainsTool } from './tools/listDomains.js';
export { CfRegGetDomainInfoTool } from './tools/getDomainInfo.js';
export { CfRegConfigureDnsTool } from './tools/configureDns.js';
export { CfRegTransferDomainTool } from './tools/transferDomain.js';

export default createExtensionPack;
