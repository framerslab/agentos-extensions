// @ts-nocheck
/**
 * Multi-Channel Post Extension Pack — publish adapted content to N social platforms.
 */

import { MultiChannelPostTool } from './MultiChannelPostTool.js';
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
  const tool = new MultiChannelPostTool();

  return {
    name: '@framers/agentos-ext-tool-multi-channel-post',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
    onActivate: async () => context.logger?.info('Multi-Channel Post Extension activated'),
    onDeactivate: async () => context.logger?.info('Multi-Channel Post Extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { MultiChannelPostTool } from './MultiChannelPostTool.js';
export type {
  MultiChannelPostInput,
  MultiChannelPostOutput,
  PlatformPostResult,
  ToolExecutorFn,
} from './MultiChannelPostTool.js';

export default createExtensionPack;
