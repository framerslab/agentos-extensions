// @ts-nocheck
/**
 * @fileoverview Image generation tool — generates images from text prompts
 * using the configured image provider stack.
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import type { ImageGenerationService, GenerateImageOptions } from '../ImageGenerationService.js';

export interface GenerateImageInput {
  prompt: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536' | '1792x1024' | '1024x1792';
  aspectRatio?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  provider?: 'openai' | 'openrouter' | 'stability' | 'replicate';
  /** The provider's own model id, without a provider prefix. */
  model?: string;
  seed?: number;
  negativePrompt?: string;
}

export interface GenerateImageOutput {
  /** The image as a URL: the provider's, or the file: URL of the copy that was saved of the image data it returned. */
  url: string;
  revisedPrompt?: string;
  provider: string;
  model: string;
  size: string;
}

const QUALITIES = ['low', 'medium', 'high', 'auto', 'standard', 'hd'];
const STYLES = ['vivid', 'natural'];
const PROVIDERS = ['openai', 'openrouter', 'stability', 'replicate'];
/** The arguments that are optional strings. */
const STRING_FIELDS = ['size', 'aspectRatio', 'model', 'negativePrompt'];

export class GenerateImageTool implements ITool<GenerateImageInput, GenerateImageOutput> {
  readonly id = 'tool.generate_image';
  readonly name = 'generate_image';
  readonly displayName = 'Generate Image';
  readonly description =
    'Generate an image from a text prompt using the configured image providers. Returns the image as a URL: ' +
    'the provider\'s, or the file: URL of a copy saved on this machine, which the image-editing and vision tools accept as a source.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed text description of the image to generate. Be specific about style, subject, composition, lighting, and mood.',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
        description: 'Image dimensions. 1024x1024 (square, default), 1536x1024 or 1792x1024 (landscape), 1024x1536 or 1024x1792 (portrait).',
      },
      aspectRatio: {
        type: 'string',
        description: 'Optional aspect ratio hint for providers that support it, such as 1:1, 16:9, or 9:16.',
      },
      quality: {
        type: 'string',
        enum: QUALITIES,
        description: 'Image quality: low, medium (default), high, or auto. "standard" and "hd" are read as medium and high. Higher quality costs more.',
      },
      style: {
        type: 'string',
        enum: STYLES,
        description: 'Optional style: "vivid" for hyper-real and dramatic, "natural" for more realistic.',
      },
      provider: {
        type: 'string',
        enum: PROVIDERS,
        description: 'Which AI provider to use. If omitted, the extension uses its configured default provider.',
      },
      model: {
        type: 'string',
        description: "Optional: the provider's own model id, for example gpt-image-2.5-flare, stable-image-core, or black-forest-labs/flux-schnell.",
      },
      seed: {
        type: 'number',
        description: 'Optional seed for providers that support reproducible image generation.',
      },
      negativePrompt: {
        type: 'string',
        description: 'Optional negative prompt for providers that support excluding specific traits or artifacts.',
      },
    },
    required: ['prompt'],
  };

  private service: ImageGenerationService;

  constructor(service: ImageGenerationService) {
    this.service = service;
  }

  async execute(
    args: GenerateImageInput,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult<GenerateImageOutput>> {
    const options = this.optionsFrom(args);
    if (typeof options === 'string') return { success: false, error: options };
    try {
      const result = await this.service.generateImage(options, context);

      return {
        success: true,
        output: {
          url: result.url,
          revisedPrompt: result.revisedPrompt,
          provider: result.provider,
          model: result.model,
          size: result.size,
        },
        details: {
          displayText: result.revisedPrompt
            ? `Image generated (${result.model}): ${result.url}\nRevised prompt: ${result.revisedPrompt}`
            : `Image generated (${result.model}): ${result.url}`,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message,
        details: message.includes('API_KEY')
          ? { apiKeyGuidance: message }
          : undefined,
      };
    }
  }

  /**
   * The service call for a tool call's arguments, or the error for an
   * argument the schema does not allow. Only the schema's own fields are
   * taken: the model writes the arguments, and anything else it adds (`n`,
   * `providerOptions`, whose `extraBody` goes into the provider's request)
   * is not passed on.
   */
  private optionsFrom(args: GenerateImageInput): GenerateImageOptions | string {
    if (typeof args?.prompt !== 'string' || !args.prompt.trim()) return 'prompt is required.';
    const options: GenerateImageOptions = { prompt: args.prompt };
    for (const field of STRING_FIELDS) {
      const value = args[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') return `${field} must be a string.`;
      if (value.trim()) options[field] = value.trim();
    }
    for (const [field, allowed] of [['quality', QUALITIES], ['style', STYLES], ['provider', PROVIDERS]]) {
      const value = args[field];
      if (value === undefined || value === null) continue;
      if (!allowed.includes(value)) return `${field} must be one of ${allowed.join(', ')}.`;
      options[field] = value;
    }
    if (args.seed !== undefined && args.seed !== null) {
      const seed = typeof args.seed === 'string' && args.seed.trim() !== '' ? Number(args.seed) : args.seed;
      if (typeof seed !== 'number' || !Number.isFinite(seed)) return 'seed must be a number.';
      options.seed = seed;
    }
    return options;
  }
}
