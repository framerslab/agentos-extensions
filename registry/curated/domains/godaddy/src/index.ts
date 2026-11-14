// @ts-nocheck
/**
 * @fileoverview GoDaddy Domain Registrar Extension for AgentOS.
 *
 * Provides 5 tools for searching, registering, and managing domains and DNS
 * records via the GoDaddy REST API.
 *
 * @module @framers/agentos-ext-domain-godaddy
 */

import { GoDaddyService } from './GoDaddyService.js';
import type { GoDaddyConfig } from './GoDaddyService.js';
import { GoDaddySearchDomainTool } from './tools/searchDomain.js';
import { GoDaddyRegisterDomainTool } from './tools/registerDomain.js';
import { GoDaddyListDomainsTool } from './tools/listDomains.js';
import { GoDaddyConfigureDnsTool } from './tools/configureDns.js';
import { GoDaddyGetDomainInfoTool } from './tools/getDomainInfo.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GoDaddyDomainOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: GoDaddyDomainOptions, secrets: Record<string, string>): GoDaddyConfig {
  return {
    apiKey:
      opts.apiKey ?? secrets['godaddy.apiKey']
      ?? process.env.GODADDY_API_KEY ?? '',
    apiSecret:
      opts.apiSecret ?? secrets['godaddy.apiSecret']
      ?? process.env.GODADDY_API_SECRET ?? '',
    baseUrl:
      opts.baseUrl ?? process.env.GODADDY_BASE_URL,
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
  const opts = (context.options ?? {}) as GoDaddyDomainOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new GoDaddyService(config);

  const searchDomainTool = new GoDaddySearchDomainTool(service);
  const registerDomainTool = new GoDaddyRegisterDomainTool(service);
  const listDomainsTool = new GoDaddyListDomainsTool(service);
  const configureDnsTool = new GoDaddyConfigureDnsTool(service);
  const getDomainInfoTool = new GoDaddyGetDomainInfoTool(service);

  return {
    name: '@framers/agentos-ext-domain-godaddy',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'godaddySearchDomain', kind: 'tool', priority: 40, payload: searchDomainTool },
      { id: 'godaddyRegisterDomain', kind: 'tool', priority: 40, payload: registerDomainTool },
      { id: 'godaddyListDomains', kind: 'tool', priority: 40, payload: listDomainsTool },
      { id: 'godaddyConfigureDns', kind: 'tool', priority: 40, payload: configureDnsTool },
      { id: 'godaddyGetDomainInfo', kind: 'tool', priority: 40, payload: getDomainInfoTool },
    ],
    onActivate: async () => {
      if (!config.apiKey) {
        throw new Error(
          'GoDaddy: no API key provided. Set GODADDY_API_KEY environment variable, '
          + 'or provide it via secrets["godaddy.apiKey"].',
        );
      }
      if (!config.apiSecret) {
        throw new Error(
          'GoDaddy: no API secret provided. Set GODADDY_API_SECRET environment variable, '
          + 'or provide it via secrets["godaddy.apiSecret"].',
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

export { GoDaddyService } from './GoDaddyService.js';
export type {
  GoDaddyConfig,
  DomainAvailability,
  DomainSummary,
  DomainDetail,
  DomainContact,
  DnsRecord,
  DomainPurchaseRequest,
  PurchaseResult,
} from './GoDaddyService.js';
export { GoDaddySearchDomainTool } from './tools/searchDomain.js';
export { GoDaddyRegisterDomainTool } from './tools/registerDomain.js';
export { GoDaddyListDomainsTool } from './tools/listDomains.js';
export { GoDaddyConfigureDnsTool } from './tools/configureDns.js';
export { GoDaddyGetDomainInfoTool } from './tools/getDomainInfo.js';

export default createExtensionPack;
