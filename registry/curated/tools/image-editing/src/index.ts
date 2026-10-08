// @ts-nocheck
/**
 * @fileoverview Image Editing Extension Pack: img2img, inpainting, outpainting,
 * style transfer, upscaling and variations as agent tools, on AgentOS's image
 * functions (`editImage`, `transferStyle`, `upscaleImage`, `variateImage`).
 *
 * Keys come from the pack options, then the secrets `openai.apiKey`,
 * `stability.apiKey` and `replicate.apiToken`, then `OPENAI_API_KEY`,
 * `STABILITY_API_KEY` and `REPLICATE_API_TOKEN`. A tool given no provider
 * takes the first that has a key; with no key at all, AgentOS chooses a
 * provider from the environment.
 *
 * @module @framers/agentos-ext-image-editing
 */

import { createRequire } from 'node:module';
import { EditImageTool } from './tools/editImage.js';
import { UpscaleImageTool } from './tools/upscaleImage.js';
import { VariateImageTool } from './tools/variateImage.js';
import type { ProviderKeys } from './shared.js';

const { version } = createRequire(import.meta.url)('../package.json');

export interface ExtensionContext {
  options?: ImageEditingExtensionOptions & Record<string, unknown>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
}

export interface ImageEditingExtensionOptions {
  openaiApiKey?: string;
  stabilityApiKey?: string;
  replicateApiToken?: string;
  priority?: number;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    payload: unknown;
    requiredSecrets?: Array<{ id: string; optional?: boolean }>;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

/**
 * Create the Image Editing extension pack: the tools editImage, upscaleImage
 * and variateImage.
 */
export function createExtensionPack(context: ExtensionContext = {}): ExtensionPack {
  const options = context.options ?? {};
  const keys: ProviderKeys = {
    openai: options.openaiApiKey || context.getSecret?.('openai.apiKey') || process.env.OPENAI_API_KEY,
    stability: options.stabilityApiKey || context.getSecret?.('stability.apiKey') || process.env.STABILITY_API_KEY,
    replicate: options.replicateApiToken || context.getSecret?.('replicate.apiToken') || process.env.REPLICATE_API_TOKEN,
  };
  const priority = options.priority ?? 50;
  const edit = new EditImageTool(keys);
  const upscale = new UpscaleImageTool(keys);
  const variate = new VariateImageTool(keys);

  return {
    name: '@framers/agentos-ext-image-editing',
    version,
    descriptors: [
      // Each descriptor id matches its tool's name, which the tool executor looks up.
      {
        id: edit.name,
        kind: 'tool',
        priority,
        payload: edit,
        requiredSecrets: [
          { id: 'openai.apiKey', optional: true },
          { id: 'stability.apiKey', optional: true },
          { id: 'replicate.apiToken', optional: true },
        ],
      },
      {
        id: upscale.name,
        kind: 'tool',
        priority,
        payload: upscale,
        requiredSecrets: [
          { id: 'stability.apiKey', optional: true },
          { id: 'replicate.apiToken', optional: true },
        ],
      },
      {
        id: variate.name,
        kind: 'tool',
        priority,
        payload: variate,
        requiredSecrets: [
          { id: 'openai.apiKey', optional: true },
          { id: 'stability.apiKey', optional: true },
          { id: 'replicate.apiToken', optional: true },
        ],
      },
    ],
    onActivate: async () => context.logger?.info('Image Editing Extension activated'),
    onDeactivate: async () => context.logger?.info('Image Editing Extension deactivated'),
  };
}

export { EditImageTool, UpscaleImageTool, VariateImageTool };
export type { EditImageInput, EditImageOutput } from './tools/editImage.js';
export type { UpscaleImageInput, UpscaleImageOutput } from './tools/upscaleImage.js';
export type { VariateImageInput, VariateImageOutput } from './tools/variateImage.js';
export default createExtensionPack;
