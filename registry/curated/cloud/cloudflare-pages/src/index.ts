// @ts-nocheck
/**
 * @fileoverview Cloudflare Pages & Workers Extension for AgentOS.
 *
 * Provides 4 tools for deploying Pages projects, managing DNS records,
 * and deploying Worker scripts via the Cloudflare API v4.
 *
 * @module @framers/agentos-ext-cloud-cloudflare-pages
 */

import { CloudflareService } from './CloudflareService.js';
import type { CloudflareConfig } from './CloudflareService.js';
import { CfDeployPagesTool } from './tools/deploy.js';
import { CfListProjectsTool } from './tools/listProjects.js';
import { CfConfigureDnsTool } from './tools/configureDns.js';
import { CfCreateWorkerTool } from './tools/createWorker.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CloudflarePagesOptions {
  apiToken?: string;
  accountId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: CloudflarePagesOptions, secrets: Record<string, string>): CloudflareConfig {
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
  const opts = (context.options ?? {}) as CloudflarePagesOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new CloudflareService(config);

  const deployTool = new CfDeployPagesTool(service);
  const listProjectsTool = new CfListProjectsTool(service);
  const configureDnsTool = new CfConfigureDnsTool(service);
  const createWorkerTool = new CfCreateWorkerTool(service);

  return {
    name: '@framers/agentos-ext-cloud-cloudflare-pages',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'cfDeployPages', kind: 'tool', priority: 40, payload: deployTool },
      { id: 'cfListProjects', kind: 'tool', priority: 40, payload: listProjectsTool },
      { id: 'cfConfigureDns', kind: 'tool', priority: 40, payload: configureDnsTool },
      { id: 'cfCreateWorker', kind: 'tool', priority: 40, payload: createWorkerTool },
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
          'Cloudflare: no Account ID provided. Set CLOUDFLARE_ACCOUNT_ID environment variable, '
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

export { CloudflareService } from './CloudflareService.js';
export type {
  CloudflareConfig,
  CloudflarePagesProject,
  CloudflareDeployment,
  CloudflareDnsRecord,
  CloudflareZone,
  CloudflareWorker,
  DeployPagesResult,
  CreatePagesProjectOptions,
  DeployWorkerOptions,
} from './CloudflareService.js';
export { CfDeployPagesTool } from './tools/deploy.js';
export { CfListProjectsTool } from './tools/listProjects.js';
export { CfConfigureDnsTool } from './tools/configureDns.js';
export { CfCreateWorkerTool } from './tools/createWorker.js';

export default createExtensionPack;
