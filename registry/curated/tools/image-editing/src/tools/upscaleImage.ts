// @ts-nocheck
/**
 * @fileoverview The upscaleImage tool: 2x or 4x super-resolution through
 * AgentOS's `upscaleImage`.
 */

import { upscaleImage } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import { chooseProvider, imageLink, imageSource, messageOf, sourceError, type ProviderKeys } from '../shared.js';

/** The upscaleImage tool's input. The image is a data:image URL or an http(s) URL on a public host. */
export interface UpscaleImageInput {
  imageUrl: string;
  scale?: 2 | 4;
  provider?: 'stability' | 'replicate' | 'auto';
  model?: string;
}

/** The upscaleImage tool's output. */
export interface UpscaleImageOutput {
  /** The upscaled image as a URL, or a data URL when the provider returned image data. */
  image: string;
  provider: string;
  model: string;
  costUSD?: number;
}

/** The upscaleImage tool, on AgentOS's `upscaleImage`. */
export class UpscaleImageTool implements ITool<UpscaleImageInput, UpscaleImageOutput> {
  readonly id = 'tool.upscaleImage';
  readonly name = 'upscaleImage';
  readonly displayName = 'Upscale Image';
  readonly description = 'Upscale an image to 2x or 4x its resolution with a super-resolution model. Returns the image as a URL.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: { type: 'string', description: 'The source image: an http(s) URL or a data:image URL.' },
      scale: { type: 'number', enum: [2, 4], description: 'The upscale factor (default 2).' },
      provider: {
        type: 'string',
        enum: ['stability', 'replicate', 'auto'],
        description: 'The image provider. auto (default) takes the first one with a key.',
      },
      model: { type: 'string', description: 'Optional provider model id.' },
    },
    required: ['imageUrl'],
  };

  constructor(private readonly keys: ProviderKeys) {}

  async execute(args: UpscaleImageInput, _context?: ToolExecutionContext): Promise<ToolExecutionResult<UpscaleImageOutput>> {
    const image = imageSource(args.imageUrl);
    if (!image) return { success: false, error: sourceError('imageUrl') };
    const scale = args.scale === 4 ? 4 : 2;
    const { provider, apiKey } = chooseProvider(args.provider, ['stability', 'replicate'], this.keys);
    try {
      const result = await upscaleImage({ image, scale, provider, apiKey, model: args.model });
      const image = imageLink(result.image);
      if (!image) return { success: false, error: 'The provider returned no image.' };
      return { success: true, output: { image, provider: result.provider, model: result.model, costUSD: result.usage?.costUSD } };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }
}
