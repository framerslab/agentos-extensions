// @ts-nocheck
/**
 * @fileoverview Vercel Cloud Extension for AgentOS.
 *
 * Provides 5 tools for deploying projects, managing domains, and configuring
 * environment variables via the Vercel REST API.
 *
 * @module @framers/agentos-ext-cloud-vercel
 */

import { VercelService } from './VercelService.js';
import type { VercelConfig } from './VercelService.js';
import { VercelDeployTool } from './tools/deploy.js';
import { VercelListProjectsTool } from './tools/listProjects.js';
import { VercelGetDeploymentTool } from './tools/getDeployment.js';
import { VercelConfigureDomainTool } from './tools/configureDomain.js';
import { VercelSetEnvVarsTool } from './tools/setEnvVars.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VercelCloudOptions {
  token?: string;
  teamId?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: VercelCloudOptions, secrets: Record<string, string>): VercelConfig {
  return {
    token:
      opts.token ?? secrets['vercel.token']
      ?? process.env.VERCEL_TOKEN ?? '',
    teamId:
      opts.teamId ?? secrets['vercel.teamId']
      ?? process.env.VERCEL_TEAM_ID,
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
  const opts = (context.options ?? {}) as VercelCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new VercelService(config);

  const deployTool = new VercelDeployTool(service);
  const listProjectsTool = new VercelListProjectsTool(service);
  const getDeploymentTool = new VercelGetDeploymentTool(service);
  const configureDomainTool = new VercelConfigureDomainTool(service);
  const setEnvVarsTool = new VercelSetEnvVarsTool(service);

  return {
    name: '@framers/agentos-ext-cloud-vercel',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'vercelDeploy', kind: 'tool', priority: 40, payload: deployTool },
      { id: 'vercelListProjects', kind: 'tool', priority: 40, payload: listProjectsTool },
      { id: 'vercelGetDeployment', kind: 'tool', priority: 40, payload: getDeploymentTool },
      { id: 'vercelConfigureDomain', kind: 'tool', priority: 40, payload: configureDomainTool },
      { id: 'vercelSetEnvVars', kind: 'tool', priority: 40, payload: setEnvVarsTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'Vercel: no API token provided. Set VERCEL_TOKEN environment variable, '
          + 'or provide it via secrets["vercel.token"].',
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

export { VercelService } from './VercelService.js';
export type { VercelConfig, VercelProject, VercelDeployment, VercelDomain, VercelEnvVar, DeployResult, DeployFromGitOptions } from './VercelService.js';
export { VercelDeployTool } from './tools/deploy.js';
export { VercelListProjectsTool } from './tools/listProjects.js';
export { VercelGetDeploymentTool } from './tools/getDeployment.js';
export { VercelConfigureDomainTool } from './tools/configureDomain.js';
export { VercelSetEnvVarsTool } from './tools/setEnvVars.js';

export default createExtensionPack;
