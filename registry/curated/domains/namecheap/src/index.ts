// @ts-nocheck
/**
 * @fileoverview Namecheap Domain Registrar Extension for AgentOS.
 *
 * Provides 5 tools for searching, registering, and managing domains
 * and DNS records via the Namecheap XML API.
 *
 * @module @framers/agentos-ext-domain-namecheap
 */

import { NamecheapService } from './NamecheapService.js';
import type { NamecheapConfig } from './NamecheapService.js';
import { NamecheapSearchDomainTool } from './tools/searchDomain.js';
import { NamecheapRegisterDomainTool } from './tools/registerDomain.js';
import { NamecheapListDomainsTool } from './tools/listDomains.js';
import { NamecheapConfigureDnsTool } from './tools/configureDns.js';
import { NamecheapGetDnsRecordsTool } from './tools/getDnsRecords.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface NamecheapDomainOptions {
  apiUser?: string;
  apiKey?: string;
  userName?: string;
  clientIp?: string;
  useSandbox?: boolean;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: NamecheapDomainOptions, secrets: Record<string, string>): NamecheapConfig {
  return {
    apiUser:
      opts.apiUser ?? secrets['namecheap.apiUser']
      ?? process.env.NAMECHEAP_API_USER ?? '',
    apiKey:
      opts.apiKey ?? secrets['namecheap.apiKey']
      ?? process.env.NAMECHEAP_API_KEY ?? '',
    userName:
      opts.userName ?? secrets['namecheap.userName']
      ?? process.env.NAMECHEAP_USERNAME,
    clientIp:
      opts.clientIp ?? secrets['namecheap.clientIp']
      ?? process.env.NAMECHEAP_CLIENT_IP ?? '',
    useSandbox:
      opts.useSandbox ?? (process.env.NAMECHEAP_SANDBOX === 'true'),
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
  const opts = (context.options ?? {}) as NamecheapDomainOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new NamecheapService(config);

  const searchDomainTool = new NamecheapSearchDomainTool(service);
  const registerDomainTool = new NamecheapRegisterDomainTool(service);
  const listDomainsTool = new NamecheapListDomainsTool(service);
  const configureDnsTool = new NamecheapConfigureDnsTool(service);
  const getDnsRecordsTool = new NamecheapGetDnsRecordsTool(service);

  return {
    name: '@framers/agentos-ext-domain-namecheap',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'namecheapSearchDomain', kind: 'tool', priority: 40, payload: searchDomainTool },
      { id: 'namecheapRegisterDomain', kind: 'tool', priority: 40, payload: registerDomainTool },
      { id: 'namecheapListDomains', kind: 'tool', priority: 40, payload: listDomainsTool },
      { id: 'namecheapConfigureDns', kind: 'tool', priority: 40, payload: configureDnsTool },
      { id: 'namecheapGetDnsRecords', kind: 'tool', priority: 40, payload: getDnsRecordsTool },
    ],
    onActivate: async () => {
      if (!config.apiUser) {
        throw new Error(
          'Namecheap: no API user provided. Set NAMECHEAP_API_USER environment variable, '
          + 'or provide it via secrets["namecheap.apiUser"].',
        );
      }
      if (!config.apiKey) {
        throw new Error(
          'Namecheap: no API key provided. Set NAMECHEAP_API_KEY environment variable, '
          + 'or provide it via secrets["namecheap.apiKey"].',
        );
      }
      if (!config.clientIp) {
        throw new Error(
          'Namecheap: no client IP provided. Set NAMECHEAP_CLIENT_IP environment variable, '
          + 'or provide it via secrets["namecheap.clientIp"]. The IP must be whitelisted in your Namecheap dashboard.',
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

export { NamecheapService } from './NamecheapService.js';
export type {
  NamecheapConfig,
  DomainAvailability,
  OwnedDomain,
  DnsRecord,
  DnsHostEntry,
  ContactInfo,
  RegisterDomainOptions,
  RegisterDomainResult,
} from './NamecheapService.js';
export { NamecheapSearchDomainTool } from './tools/searchDomain.js';
export { NamecheapRegisterDomainTool } from './tools/registerDomain.js';
export { NamecheapListDomainsTool } from './tools/listDomains.js';
export { NamecheapConfigureDnsTool } from './tools/configureDns.js';
export { NamecheapGetDnsRecordsTool } from './tools/getDnsRecords.js';

export default createExtensionPack;
