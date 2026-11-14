// @ts-nocheck
/**
 * @fileoverview DigitalOcean Cloud Extension for AgentOS.
 *
 * Provides 6 tools for managing App Platform apps, Droplets, DNS records,
 * and deployments via the DigitalOcean REST API v2.
 *
 * @module @framers/agentos-ext-cloud-digitalocean
 */

import { DigitalOceanService } from './DigitalOceanService.js';
import type { DigitalOceanConfig } from './DigitalOceanService.js';
import { DOCreateAppTool } from './tools/createApp.js';
import { DOCreateDropletTool } from './tools/createDroplet.js';
import { DOListResourcesTool } from './tools/listResources.js';
import { DODeployAppTool } from './tools/deployApp.js';
import { DOManageDnsTool } from './tools/manageDns.js';
import { DODeleteResourceTool } from './tools/deleteResource.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DigitalOceanCloudOptions {
  token?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: DigitalOceanCloudOptions, secrets: Record<string, string>): DigitalOceanConfig {
  return {
    token:
      opts.token ?? secrets['digitalocean.token']
      ?? process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN ?? '',
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
  const opts = (context.options ?? {}) as DigitalOceanCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new DigitalOceanService(config);

  const createAppTool = new DOCreateAppTool(service);
  const createDropletTool = new DOCreateDropletTool(service);
  const listResourcesTool = new DOListResourcesTool(service);
  const deployAppTool = new DODeployAppTool(service);
  const manageDnsTool = new DOManageDnsTool(service);
  const deleteResourceTool = new DODeleteResourceTool(service);

  return {
    name: '@framers/agentos-ext-cloud-digitalocean',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'doCreateApp', kind: 'tool', priority: 40, payload: createAppTool },
      { id: 'doCreateDroplet', kind: 'tool', priority: 40, payload: createDropletTool },
      { id: 'doListResources', kind: 'tool', priority: 40, payload: listResourcesTool },
      { id: 'doDeployApp', kind: 'tool', priority: 40, payload: deployAppTool },
      { id: 'doManageDns', kind: 'tool', priority: 40, payload: manageDnsTool },
      { id: 'doDeleteResource', kind: 'tool', priority: 40, payload: deleteResourceTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'DigitalOcean: no API token provided. Set DIGITALOCEAN_TOKEN or DO_API_TOKEN environment variable, '
          + 'or provide it via secrets["digitalocean.token"].',
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

export { DigitalOceanService } from './DigitalOceanService.js';
export type {
  DigitalOceanConfig,
  DOApp,
  DOAppSpec,
  DOAppServiceSpec,
  DOAppStaticSiteSpec,
  DOAppEnvVar,
  DODeployment,
  DODroplet,
  DODomain,
  DODomainRecord,
  CreateAppOptions,
  CreateDropletOptions,
} from './DigitalOceanService.js';
export { DOCreateAppTool } from './tools/createApp.js';
export { DOCreateDropletTool } from './tools/createDroplet.js';
export { DOListResourcesTool } from './tools/listResources.js';
export { DODeployAppTool } from './tools/deployApp.js';
export { DOManageDnsTool } from './tools/manageDns.js';
export { DODeleteResourceTool } from './tools/deleteResource.js';

export default createExtensionPack;
