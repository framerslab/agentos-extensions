// @ts-nocheck
/**
 * @fileoverview Railway Cloud Extension for AgentOS.
 *
 * Provides 4 tools for deploying services, listing projects, provisioning
 * databases, and retrieving logs via the Railway GraphQL API.
 *
 * @module @framers/agentos-ext-cloud-railway
 */

import { RailwayService } from './RailwayService.js';
import type { RailwayConfig } from './RailwayService.js';
import { RailwayDeployServiceTool } from './tools/deployService.js';
import { RailwayListServicesTool } from './tools/listServices.js';
import { RailwayAddDatabaseTool } from './tools/addDatabase.js';
import { RailwayGetLogsTool } from './tools/getLogs.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RailwayCloudOptions {
  token?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: RailwayCloudOptions, secrets: Record<string, string>): RailwayConfig {
  return {
    token:
      opts.token ?? secrets['railway.token']
      ?? process.env.RAILWAY_TOKEN ?? '',
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
  const opts = (context.options ?? {}) as RailwayCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new RailwayService(config);

  const deployServiceTool = new RailwayDeployServiceTool(service);
  const listServicesTool = new RailwayListServicesTool(service);
  const addDatabaseTool = new RailwayAddDatabaseTool(service);
  const getLogsTool = new RailwayGetLogsTool(service);

  return {
    name: '@framers/agentos-ext-cloud-railway',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'railwayDeployService', kind: 'tool', priority: 40, payload: deployServiceTool },
      { id: 'railwayListServices', kind: 'tool', priority: 40, payload: listServicesTool },
      { id: 'railwayAddDatabase', kind: 'tool', priority: 40, payload: addDatabaseTool },
      { id: 'railwayGetLogs', kind: 'tool', priority: 40, payload: getLogsTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'Railway: no API token provided. Set RAILWAY_TOKEN environment variable, '
          + 'or provide it via secrets["railway.token"].',
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

export { RailwayService } from './RailwayService.js';
export type { RailwayConfig, RailwayProject, RailwayEnvironment, RailwayService_ as RailwayServiceInfo, RailwayDeployment, RailwayPlugin, RailwayLogEntry } from './RailwayService.js';
export { RailwayDeployServiceTool } from './tools/deployService.js';
export { RailwayListServicesTool } from './tools/listServices.js';
export { RailwayAddDatabaseTool } from './tools/addDatabase.js';
export { RailwayGetLogsTool } from './tools/getLogs.js';

export default createExtensionPack;
