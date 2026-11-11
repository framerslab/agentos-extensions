// @ts-nocheck
/**
 * Cross-Platform Social Analytics Extension Pack — aggregate engagement metrics
 * from multiple social platforms in a single query.
 */

import { CrossPlatformAnalyticsTool } from './CrossPlatformAnalyticsTool.js';
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
  const tool = new CrossPlatformAnalyticsTool();

  return {
    name: '@framers/agentos-ext-tool-social-analytics',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
    onActivate: async () => context.logger?.info('Cross-Platform Analytics Extension activated'),
    onDeactivate: async () => context.logger?.info('Cross-Platform Analytics Extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { CrossPlatformAnalyticsTool } from './CrossPlatformAnalyticsTool.js';
export type {
  CrossPlatformAnalyticsInput,
  CrossPlatformAnalyticsOutput,
  PlatformMetrics,
  PlatformAnalyticsResult,
  AnalyticsTotals,
  ToolExecutorFn,
} from './CrossPlatformAnalyticsTool.js';

export default createExtensionPack;
