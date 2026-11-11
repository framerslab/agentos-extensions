// @ts-nocheck
/**
 * @fileoverview Heroku Cloud Extension for AgentOS.
 *
 * Provides 5 tools for creating apps, deploying from source, provisioning
 * addons, retrieving logs, and scaling dynos via the Heroku Platform API.
 *
 * @module @framers/agentos-ext-cloud-heroku
 */

import { HerokuService } from './HerokuService.js';
import type { HerokuConfig } from './HerokuService.js';
import { HerokuCreateAppTool } from './tools/createApp.js';
import { HerokuDeployAppTool } from './tools/deployApp.js';
import { HerokuAddAddonTool } from './tools/addAddon.js';
import { HerokuGetLogsTool } from './tools/getLogs.js';
import { HerokuScaleDynosTool } from './tools/scaleDynos.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HerokuCloudOptions {
  apiKey?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: HerokuCloudOptions, secrets: Record<string, string>): HerokuConfig {
  return {
    apiKey:
      opts.apiKey ?? secrets['heroku.apiKey']
      ?? process.env.HEROKU_API_KEY ?? '',
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
  const opts = (context.options ?? {}) as HerokuCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new HerokuService(config);

  const createAppTool = new HerokuCreateAppTool(service);
  const deployAppTool = new HerokuDeployAppTool(service);
  const addAddonTool = new HerokuAddAddonTool(service);
  const getLogsTool = new HerokuGetLogsTool(service);
  const scaleDynosTool = new HerokuScaleDynosTool(service);

  return {
    name: '@framers/agentos-ext-cloud-heroku',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'herokuCreateApp', kind: 'tool', priority: 40, payload: createAppTool },
      { id: 'herokuDeployApp', kind: 'tool', priority: 40, payload: deployAppTool },
      { id: 'herokuAddAddon', kind: 'tool', priority: 40, payload: addAddonTool },
      { id: 'herokuGetLogs', kind: 'tool', priority: 40, payload: getLogsTool },
      { id: 'herokuScaleDynos', kind: 'tool', priority: 40, payload: scaleDynosTool },
    ],
    onActivate: async () => {
      if (!config.apiKey) {
        throw new Error(
          'Heroku: no API key provided. Set HEROKU_API_KEY environment variable, '
          + 'or provide it via secrets["heroku.apiKey"].',
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

export { HerokuService } from './HerokuService.js';
export type { HerokuConfig, HerokuApp, HerokuBuild, HerokuAddon, HerokuLogSession, HerokuFormation } from './HerokuService.js';
export { HerokuCreateAppTool } from './tools/createApp.js';
export { HerokuDeployAppTool } from './tools/deployApp.js';
export { HerokuAddAddonTool } from './tools/addAddon.js';
export { HerokuGetLogsTool } from './tools/getLogs.js';
export { HerokuScaleDynosTool } from './tools/scaleDynos.js';

export default createExtensionPack;
