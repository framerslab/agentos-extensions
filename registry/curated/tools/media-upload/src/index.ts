// @ts-nocheck
/**
 * Media Upload Extension Pack — upload media files to the library for social posts.
 */

import { MediaUploadTool } from './MediaUploadTool.js';
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
  const tool = new MediaUploadTool();

  return {
    name: '@framers/agentos-ext-tool-media-upload',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool' as const,
        priority: 50,
        payload: tool,
      },
    ],
    onActivate: async () => context.logger?.info('Media Upload Extension activated'),
    onDeactivate: async () => context.logger?.info('Media Upload Extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { MediaUploadTool } from './MediaUploadTool.js';
export type {
  MediaUploadInput,
  MediaUploadOutput,
  ToolExecutorFn,
} from './MediaUploadTool.js';

export default createExtensionPack;
