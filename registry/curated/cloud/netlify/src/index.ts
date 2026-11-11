// @ts-nocheck
/**
 * @fileoverview Netlify Cloud Extension for AgentOS.
 *
 * Provides 4 tools for deploying sites, managing domains, and configuring
 * environment variables via the Netlify REST API.
 *
 * @module @framers/agentos-ext-cloud-netlify
 */

import { NetlifyService } from './NetlifyService.js';
import type { NetlifyConfig } from './NetlifyService.js';
import { NetlifyDeployTool } from './tools/deploy.js';
import { NetlifyListSitesTool } from './tools/listSites.js';
import { NetlifyConfigureDomainTool } from './tools/configureDomain.js';
import { NetlifySetEnvVarsTool } from './tools/setEnvVars.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface NetlifyCloudOptions {
  token?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: NetlifyCloudOptions, secrets: Record<string, string>): NetlifyConfig {
  return {
    token:
      opts.token ?? secrets['netlify.token']
      ?? process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_TOKEN ?? '',
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
  const opts = (context.options ?? {}) as NetlifyCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new NetlifyService(config);

  const deployTool = new NetlifyDeployTool(service);
  const listSitesTool = new NetlifyListSitesTool(service);
  const configureDomainTool = new NetlifyConfigureDomainTool(service);
  const setEnvVarsTool = new NetlifySetEnvVarsTool(service);

  return {
    name: '@framers/agentos-ext-cloud-netlify',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'netlifyDeploySite', kind: 'tool', priority: 40, payload: deployTool },
      { id: 'netlifyListSites', kind: 'tool', priority: 40, payload: listSitesTool },
      { id: 'netlifyConfigureDomain', kind: 'tool', priority: 40, payload: configureDomainTool },
      { id: 'netlifySetEnvVars', kind: 'tool', priority: 40, payload: setEnvVarsTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'Netlify: no API token provided. Set NETLIFY_AUTH_TOKEN or NETLIFY_TOKEN environment variable, '
          + 'or provide it via secrets["netlify.token"].',
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

export { NetlifyService } from './NetlifyService.js';
export type { NetlifyConfig, NetlifySite, NetlifyDeploy, NetlifyDomain, NetlifyEnvVar, DeployResult, DeployFromGitOptions } from './NetlifyService.js';
export { NetlifyDeployTool } from './tools/deploy.js';
export { NetlifyListSitesTool } from './tools/listSites.js';
export { NetlifyConfigureDomainTool } from './tools/configureDomain.js';
export { NetlifySetEnvVarsTool } from './tools/setEnvVars.js';

export default createExtensionPack;
