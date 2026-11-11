// @ts-nocheck
/**
 * @fileoverview Linode/Akamai Cloud Extension for AgentOS.
 *
 * Provides 6 tools for provisioning instances, deploying StackScripts,
 * managing DNS, deleting instances, and creating NodeBalancers via the
 * Linode REST API v4.
 *
 * @module @framers/agentos-ext-cloud-linode
 */

import { LinodeService } from './LinodeService.js';
import type { LinodeConfig } from './LinodeService.js';
import { LinodeCreateInstanceTool } from './tools/createInstance.js';
import { LinodeListInstancesTool } from './tools/listInstances.js';
import { LinodeDeployStackScriptTool } from './tools/deployStackScript.js';
import { LinodeManageDnsTool } from './tools/manageDns.js';
import { LinodeDeleteInstanceTool } from './tools/deleteInstance.js';
import { LinodeCreateNodeBalancerTool } from './tools/createNodeBalancer.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LinodeCloudOptions {
  token?: string;
  baseUrl?: string;
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Secret Resolution
// ---------------------------------------------------------------------------

function resolveConfig(opts: LinodeCloudOptions, secrets: Record<string, string>): LinodeConfig {
  return {
    token:
      opts.token ?? secrets['linode.token']
      ?? process.env.LINODE_TOKEN ?? process.env.LINODE_API_TOKEN ?? '',
    baseUrl: opts.baseUrl,
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
  const opts = (context.options ?? {}) as LinodeCloudOptions;
  const secrets = opts.secrets ?? context.secrets ?? {};
  const config = resolveConfig(opts, secrets);

  const service = new LinodeService(config);

  const createInstanceTool = new LinodeCreateInstanceTool(service);
  const listInstancesTool = new LinodeListInstancesTool(service);
  const deployStackScriptTool = new LinodeDeployStackScriptTool(service);
  const manageDnsTool = new LinodeManageDnsTool(service);
  const deleteInstanceTool = new LinodeDeleteInstanceTool(service);
  const createNodeBalancerTool = new LinodeCreateNodeBalancerTool(service);

  return {
    name: '@framers/agentos-ext-cloud-linode',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'linodeCreateInstance', kind: 'tool', priority: 40, payload: createInstanceTool },
      { id: 'linodeListInstances', kind: 'tool', priority: 40, payload: listInstancesTool },
      { id: 'linodeDeployStackScript', kind: 'tool', priority: 40, payload: deployStackScriptTool },
      { id: 'linodeManageDns', kind: 'tool', priority: 40, payload: manageDnsTool },
      { id: 'linodeDeleteInstance', kind: 'tool', priority: 40, payload: deleteInstanceTool },
      { id: 'linodeCreateNodeBalancer', kind: 'tool', priority: 40, payload: createNodeBalancerTool },
    ],
    onActivate: async () => {
      if (!config.token) {
        throw new Error(
          'Linode: no API token provided. Set LINODE_TOKEN or LINODE_API_TOKEN environment variable, '
          + 'or provide it via secrets["linode.token"].',
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

export { LinodeService } from './LinodeService.js';
export type {
  LinodeConfig,
  LinodeInstance,
  LinodeCreateOptions,
  LinodeDomain,
  LinodeDomainRecord,
  LinodeType,
  LinodeRegion,
  LinodeNodeBalancer,
  NodeBalancerConfigOptions,
  NodeBalancerNode,
} from './LinodeService.js';
export { LinodeCreateInstanceTool } from './tools/createInstance.js';
export { LinodeListInstancesTool } from './tools/listInstances.js';
export { LinodeDeployStackScriptTool } from './tools/deployStackScript.js';
export { LinodeManageDnsTool } from './tools/manageDns.js';
export { LinodeDeleteInstanceTool } from './tools/deleteInstance.js';
export { LinodeCreateNodeBalancerTool } from './tools/createNodeBalancer.js';

export default createExtensionPack;
