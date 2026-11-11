// @ts-nocheck
/**
 * @fileoverview Porkbun Domain Registrar Extension for AgentOS.
 *
 * Provides 5 tools for searching, registering, and managing domains and DNS
 * records via the Porkbun API v3.
 *
 * @module @framers/agentos-ext-domain-porkbun
 */

import { PorkbunService } from './PorkbunService.js';
import type { PorkbunConfig } from './PorkbunService.js';
import { PorkbunSearchDomainTool } from './tools/searchDomain.js';
import { PorkbunRegisterDomainTool } from './tools/registerDomain.js';
import { PorkbunListDomainsTool } from './tools/listDomains.js';
import { PorkbunConfigureDnsTool } from './tools/configureDns.js';
import { PorkbunTransferDomainTool } from './tools/transferDomain.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PorkbunDomainOptions {
  apiKey?: string;
  secretApiKey?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: PorkbunDomainOptions, secrets: Record<string, string>): PorkbunConfig {
  return {
    apiKey:
      opts.apiKey ?? secrets['porkbun.apiKey']
      ?? process.env.PORKBUN_API_KEY ?? '',
    secretApiKey:
      opts.secretApiKey ?? secrets['porkbun.secretApiKey']
      ?? process.env.PORKBUN_SECRET_API_KEY ?? '',
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
  const opts = (context.options ?? {}) as PorkbunDomainOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new PorkbunService(config);

  const searchDomainTool = new PorkbunSearchDomainTool(service);
  const registerDomainTool = new PorkbunRegisterDomainTool(service);
  const listDomainsTool = new PorkbunListDomainsTool(service);
  const configureDnsTool = new PorkbunConfigureDnsTool(service);
  const transferDomainTool = new PorkbunTransferDomainTool(service);

  return {
    name: '@framers/agentos-ext-domain-porkbun',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'porkbunSearchDomain', kind: 'tool', priority: 40, payload: searchDomainTool },
      { id: 'porkbunRegisterDomain', kind: 'tool', priority: 40, payload: registerDomainTool },
      { id: 'porkbunListDomains', kind: 'tool', priority: 40, payload: listDomainsTool },
      { id: 'porkbunConfigureDns', kind: 'tool', priority: 40, payload: configureDnsTool },
      { id: 'porkbunTransferDomain', kind: 'tool', priority: 40, payload: transferDomainTool },
    ],
    onActivate: async () => {
      if (!config.apiKey) {
        throw new Error(
          'Porkbun: no API key provided. Set PORKBUN_API_KEY environment variable, '
          + 'or provide it via secrets["porkbun.apiKey"].',
        );
      }
      if (!config.secretApiKey) {
        throw new Error(
          'Porkbun: no secret API key provided. Set PORKBUN_SECRET_API_KEY environment variable, '
          + 'or provide it via secrets["porkbun.secretApiKey"].',
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

export { PorkbunService } from './PorkbunService.js';
export type {
  PorkbunConfig,
  DomainAvailability,
  DomainPricing,
  OwnedDomain,
  DnsRecord,
  DnsRecordInput,
  RegisterDomainOptions,
  RegisterDomainResult,
  TransferDomainResult,
} from './PorkbunService.js';
export { PorkbunSearchDomainTool } from './tools/searchDomain.js';
export { PorkbunRegisterDomainTool } from './tools/registerDomain.js';
export { PorkbunListDomainsTool } from './tools/listDomains.js';
export { PorkbunConfigureDnsTool } from './tools/configureDns.js';
export { PorkbunTransferDomainTool } from './tools/transferDomain.js';

export default createExtensionPack;
