// @ts-nocheck
/**
 * @fileoverview The variateImage tool: variations of an image through
 * AgentOS's `variateImage`.
 */

import { variateImage } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import { chooseProvider, imageLink, imageSource, messageOf, sourceError, type ProviderKeys } from '../shared.js';

/** The variateImage tool's input. The image is a data:image URL or an http(s) URL on a public host. */
export interface VariateImageInput {
  imageUrl: string;
  count?: number;
  provider?: 'openai' | 'stability' | 'replicate' | 'auto';
  model?: string;
  size?: string;
}

/** The variateImage tool's output. */
export interface VariateImageOutput {
  /** Each variation as a URL, or a data URL when the provider returned image data. */
  images: string[];
  provider: string;
  model: string;
  costUSD?: number;
}

/** The most variations one call asks for. */
const MAX_VARIATIONS = 4;

/** The variateImage tool, on AgentOS's `variateImage`. */
export class VariateImageTool implements ITool<VariateImageInput, VariateImageOutput> {
  readonly id = 'tool.variateImage';
  readonly name = 'variateImage';
  readonly displayName = 'Image Variations';
  readonly description = 'Generate variations of an existing image. Returns the variations as URLs.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: { type: 'string', description: 'The source image: an http(s) URL or a data:image URL.' },
      count: { type: 'number', minimum: 1, maximum: MAX_VARIATIONS, description: `How many variations (default 1, at most ${MAX_VARIATIONS}).` },
      provider: {
        type: 'string',
        enum: ['openai', 'stability', 'replicate', 'auto'],
        description: 'The image provider. auto (default) takes the first one with a key.',
      },
      model: { type: 'string', description: 'Optional provider model id.' },
      size: { type: 'string', description: 'Optional output size, such as 1024x1024.' },
    },
    required: ['imageUrl'],
  };

  constructor(private readonly keys: ProviderKeys) {}

  async execute(args: VariateImageInput, _context?: ToolExecutionContext): Promise<ToolExecutionResult<VariateImageOutput>> {
    const image = imageSource(args.imageUrl);
    if (!image) return { success: false, error: sourceError('imageUrl') };
    const n = Math.min(MAX_VARIATIONS, Math.max(1, Math.floor(Number(args.count) || 1)));
    const choice = chooseProvider(args.provider, ['openai', 'stability', 'replicate'], this.keys);
    if (choice.error) return { success: false, error: choice.error };
    const { provider, apiKey } = choice;
    try {
      const result = await variateImage({ image, n, provider, apiKey, model: args.model, size: args.size });
      const images = (result.images ?? []).map(imageLink).filter(Boolean);
      if (images.length === 0) return { success: false, error: 'The provider returned no image.' };
      return { success: true, output: { images, provider: result.provider, model: result.model, costUSD: result.usage?.costUSD } };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }
}
