// @ts-nocheck
/**
 * @fileoverview Fly.io Cloud Extension for AgentOS.
 *
 * Provides 4 tools for deploying apps, listing apps/machines, scaling
 * instances, and creating persistent volumes via the Fly Machines API.
 *
 * @module @framers/agentos-ext-cloud-flyio
 */

import { FlyService } from './FlyService.js';
import type { FlyConfig } from './FlyService.js';
import { FlyDeployAppTool } from './tools/deployApp.js';
import { FlyListAppsTool } from './tools/listApps.js';
import { FlyScaleAppTool } from './tools/scaleApp.js';
import { FlyCreateVolumeTool } from './tools/createVolume.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FlyCloudOptions {
  token?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: FlyCloudOptions, secrets: Record<string, string>): FlyConfig {
  return {
    token:
      opts.token ?? secrets['fly.token']
      ?? process.env.FLY_API_TOKEN ?? '',
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
  const opts = (context.options ?? {}) as FlyCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new FlyService(config);

  const deployAppTool = new FlyDeployAppTool(service);
  const listAppsTool = new FlyListAppsTool(service);
  const scaleAppTool = new FlyScaleAppTool(service);
  const createVolumeTool = new FlyCreateVolumeTool(service);

  return {
    name: '@framers/agentos-ext-cloud-flyio',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'flyDeployApp', kind: 'tool', priority: 40, payload: deployAppTool },
      { id: 'flyListApps', kind: 'tool', priority: 40, payload: listAppsTool },
      { id: 'flyScaleApp', kind: 'tool', priority: 40, payload: scaleAppTool },
      { id: 'flyCreateVolume', kind: 'tool', priority: 40, payload: createVolumeTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'Fly.io: no API token provided. Set FLY_API_TOKEN environment variable, '
          + 'or provide it via secrets["fly.token"].',
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

export { FlyService } from './FlyService.js';
export type { FlyConfig, FlyApp, FlyMachine, FlyMachineConfig, FlyMachineService, FlyVolume } from './FlyService.js';
export { FlyDeployAppTool } from './tools/deployApp.js';
export { FlyListAppsTool } from './tools/listApps.js';
export { FlyScaleAppTool } from './tools/scaleApp.js';
export { FlyCreateVolumeTool } from './tools/createVolume.js';

export default createExtensionPack;
