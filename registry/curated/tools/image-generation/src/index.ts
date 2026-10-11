// @ts-nocheck
/**
 * @fileoverview Image Generation Extension Pack: the `generate_image` tool on
 * AgentOS's `generateImage`, with OpenAI, OpenRouter, Stability AI and
 * Replicate.
 *
 * Image data a provider returns is saved, never returned: to a file in the
 * images directory (`imageDir`, `AGENTOS_IMAGE_DIR`, or a folder in the
 * user's temp directory), or by the host's `saveImage`.
 */
import type {
  ExtensionPackContext,
  ExtensionPack,
  ExtensionLifecycleContext,
} from '@framers/agentos';

import { ImageGenerationService, type ImageQuality } from './ImageGenerationService.js';
import type { SaveImage } from './imageFiles.js';
import { GenerateImageTool } from './tools/generateImage.js';

// This pack compiles to CommonJS, where `require` reads the package's own
// version: `import.meta` does not exist there.
const { version } = require('../package.json');

export interface ImageGenerationOptions {
  openaiApiKey?: string;
  openrouterApiKey?: string;
  stabilityApiKey?: string;
  replicateApiToken?: string;
  defaultProvider?: 'openai' | 'openrouter' | 'stability' | 'replicate';
  defaultModel?: string;
  defaultSize?: string;
  defaultQuality?: ImageQuality;
  /**
   * Where image data a provider returns is saved, each caller in a
   * subdirectory of its own (else `AGENTOS_IMAGE_DIR`, else a folder in the
   * user's temp directory). The directory must belong to the service's user,
   * with no one else able to write it or its parents. The image-editing and
   * vision-pipeline packs take the same option: give all three the same
   * directory, so an image this pack saved is a source for them.
   */
  imageDir?: string;
  /**
   * Stores image data in place of the default saver and returns the http(s)
   * URL under which the host's clients load it. A `file:` URL names a file
   * on the machine that ran the tool, so a host whose clients are elsewhere
   * sets this.
   */
  saveImage?: SaveImage;
  priority?: number;
}

export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const options = (context.options ?? {}) as ImageGenerationOptions;

  const openaiApiKey =
    options.openaiApiKey ||
    context.getSecret?.('openai.apiKey') ||
    process.env.OPENAI_API_KEY;

  const openrouterApiKey =
    options.openrouterApiKey ||
    context.getSecret?.('openrouter.apiKey') ||
    process.env.OPENROUTER_API_KEY;

  const stabilityApiKey =
    options.stabilityApiKey ||
    context.getSecret?.('stability.apiKey') ||
    process.env.STABILITY_API_KEY;

  const replicateApiToken =
    options.replicateApiToken ||
    context.getSecret?.('replicate.apiToken') ||
    process.env.REPLICATE_API_TOKEN;

  const service = new ImageGenerationService({
    openaiApiKey,
    openrouterApiKey,
    stabilityApiKey,
    replicateApiToken,
    defaultProvider: options.defaultProvider,
    defaultModel: options.defaultModel,
    defaultSize: options.defaultSize,
    defaultQuality: options.defaultQuality,
    imageDir: options.imageDir,
    saveImage: options.saveImage,
  });

  const tool = new GenerateImageTool(service);

  return {
    name: '@framers/agentos-ext-image-generation',
    version,
    descriptors: [
      {
        id: tool.name,
        kind: 'tool',
        priority: options.priority ?? 50,
        payload: tool,
        requiredSecrets: [
          { id: 'openai.apiKey', optional: true },
          { id: 'openrouter.apiKey', optional: true },
          { id: 'stability.apiKey', optional: true },
          { id: 'replicate.apiToken', optional: true },
        ],
      },
    ],
    onActivate: async (lc?: ExtensionLifecycleContext) => {
      await service.initialize();
      const providers: string[] = [];
      if (service.hasOpenAI) providers.push('OpenAI');
      if (service.hasOpenRouter) providers.push('OpenRouter');
      if (service.hasStability) providers.push('Stability AI');
      if (service.hasReplicate) providers.push('Replicate');
      const status = providers.length > 0
        ? providers.join(' + ')
        : 'no API keys configured (set OPENAI_API_KEY, OPENROUTER_API_KEY, STABILITY_API_KEY, or REPLICATE_API_TOKEN)';
      lc?.logger?.info(`Image Generation Extension activated — ${status}`);
    },
    onDeactivate: async (lc?: ExtensionLifecycleContext) => {
      await service.shutdown();
      lc?.logger?.info('Image Generation Extension deactivated');
    },
  };
}

export { ImageGenerationService } from './ImageGenerationService.js';
export type { ImageGenerationConfig, GenerateImageOptions, GeneratedImage, ImageQuality } from './ImageGenerationService.js';
export type { ImageStore, SaveImage } from './imageFiles.js';
export { GenerateImageTool } from './tools/generateImage.js';
export default createExtensionPack;
