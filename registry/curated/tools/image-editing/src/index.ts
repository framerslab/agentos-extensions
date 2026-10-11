// @ts-nocheck
/**
 * @fileoverview Image Editing Extension Pack: img2img, inpainting, style
 * transfer, upscaling and variations as agent tools, on AgentOS's image
 * functions (`editImage`, `transferStyle`, `upscaleImage`, `variateImage`).
 *
 * Keys come from the pack options, then the secrets `openai.apiKey`,
 * `stability.apiKey` and `replicate.apiToken`, then `OPENAI_API_KEY`,
 * `STABILITY_API_KEY` and `REPLICATE_API_TOKEN`. A tool given no provider
 * takes the first that has a key; with no key at all, AgentOS chooses a
 * provider from the environment.
 *
 * Image data a provider returns is saved, never returned: to a file in the
 * images directory (`imageDir`, `AGENTOS_IMAGE_DIR`, or a folder in the
 * user's temp directory), or by the host's `saveImage`.
 *
 * @module @framers/agentos-ext-image-editing
 */

import { createRequire } from 'node:module';
import { EditImageTool } from './tools/editImage.js';
import { UpscaleImageTool } from './tools/upscaleImage.js';
import { VariateImageTool } from './tools/variateImage.js';
import { imageStore, type SaveImage } from './imageFiles.js';
import type { ProviderKeys } from './shared.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** What the extension manager passes the pack factory. */
export interface ExtensionContext {
  options?: ImageEditingExtensionOptions & Record<string, unknown>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void };
}

/** Pack options. A key given here wins over the secret and the environment variable. */
export interface ImageEditingExtensionOptions {
  /** OpenAI key (else the secret `openai.apiKey`, else `OPENAI_API_KEY`). */
  openaiApiKey?: string;
  /** Stability AI key (else the secret `stability.apiKey`, else `STABILITY_API_KEY`). */
  stabilityApiKey?: string;
  /** Replicate token (else the secret `replicate.apiToken`, else `REPLICATE_API_TOKEN`). */
  replicateApiToken?: string;
  /**
   * Where image data a provider returns is saved, each caller in a
   * subdirectory of its own (else `AGENTOS_IMAGE_DIR`, else a folder in the
   * user's temp directory). The directory must belong to the service's user,
   * with no one else able to write it; it is made and checked before a
   * provider is called, so a directory the tools refuse costs no image. The image-generation
   * and vision-pipeline packs take the same option: give all three the same
   * directory, so an image one saved is a source for the others.
   */
  imageDir?: string;
  /**
   * Stores image data in place of the default saver and returns the http(s)
   * URL under which the host's clients load it. A `file:` URL names a file
   * on the machine that ran the tool, so a host whose clients are elsewhere
   * sets this.
   */
  saveImage?: SaveImage;
  /** Priority of the three tool descriptors (default 50). */
  priority?: number;
}

/** The pack the factory returns: the editImage, upscaleImage and variateImage tool descriptors. */
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
  // The first non-blank string of the option, the secret and the environment variable.
  const firstKey = (...values: unknown[]) =>
    values.map((value) => (typeof value === 'string' ? value.trim() : '')).find(Boolean) || undefined;
  const keys: ProviderKeys = {
    openai: firstKey(options.openaiApiKey, context.getSecret?.('openai.apiKey'), process.env.OPENAI_API_KEY),
    stability: firstKey(options.stabilityApiKey, context.getSecret?.('stability.apiKey'), process.env.STABILITY_API_KEY),
    replicate: firstKey(options.replicateApiToken, context.getSecret?.('replicate.apiToken'), process.env.REPLICATE_API_TOKEN),
  };
  const priority = options.priority ?? 50;
  const store = imageStore(options);
  const edit = new EditImageTool(keys, store);
  const upscale = new UpscaleImageTool(keys, store);
  const variate = new VariateImageTool(keys, store);

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
export type { ImageStore, SaveImage } from './imageFiles.js';
export type { EditImageInput, EditImageOutput } from './tools/editImage.js';
export type { UpscaleImageInput, UpscaleImageOutput } from './tools/upscaleImage.js';
export type { VariateImageInput, VariateImageOutput } from './tools/variateImage.js';
export default createExtensionPack;
