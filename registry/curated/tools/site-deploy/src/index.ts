// @ts-nocheck
/**
 * @fileoverview Site Deploy Orchestration Extension for AgentOS.
 *
 * Provides a single high-level tool that orchestrates deployment from source
 * to any supported cloud provider with optional domain registration and DNS
 * configuration via delegated tool calls.
 *
 * @module @framers/agentos-ext-tool-site-deploy
 */

import { SiteDeployTool } from './SiteDeployTool.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/* ------------------------------------------------------------------ */
/*  Extension pack types                                               */
/* ------------------------------------------------------------------ */

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    payload: unknown;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const tool = new SiteDeployTool();

  return {
    name: '@framers/agentos-ext-tool-site-deploy',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
    onActivate: async () => context.logger?.info('Site Deploy Extension activated'),
    onDeactivate: async () => context.logger?.info('Site Deploy Extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { SiteDeployTool } from './SiteDeployTool.js';
export type {
  SiteDeployInput,
  SiteDeployOutput,
  DeployStepResult,
  CloudProvider,
  DomainRegistrar,
  Framework,
  ToolExecutorFn,
} from './SiteDeployTool.js';

export default createExtensionPack;
