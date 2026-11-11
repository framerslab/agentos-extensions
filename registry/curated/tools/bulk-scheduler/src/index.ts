// @ts-nocheck
/**
 * Bulk Scheduler Extension Pack — schedule multiple social posts at once.
 */

import { BulkSchedulerTool } from './BulkSchedulerTool.js';
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
  const tool = new BulkSchedulerTool();

  return {
    name: '@framers/agentos-ext-tool-bulk-scheduler',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
    onActivate: async () => context.logger?.info('Bulk Scheduler Extension activated'),
    onDeactivate: async () => context.logger?.info('Bulk Scheduler Extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { BulkSchedulerTool } from './BulkSchedulerTool.js';
export type {
  ScheduledPost,
  BulkScheduleInput,
  BulkScheduleOutput,
  ScheduleResult,
  ToolExecutorFn,
} from './BulkSchedulerTool.js';

export default createExtensionPack;
