// @ts-nocheck
/**
 * @fileoverview The upscaleImage tool: super-resolution through AgentOS's
 * `upscaleImage`.
 */

import { upscaleImage } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import {
  chooseProvider,
  foreignModelPrefix,
  imageSource,
  imageStore,
  loadImage,
  messageOf,
  numberOf,
  optionalString,
  sourceError,
  storeImage,
  type ImageStore,
  type ProviderKeys,
} from '../shared.js';

/** The upscaleImage tool's input. The image is a data:image URL, an http(s) URL on a public host, or the file: URL of an image this tool saved. */
export interface UpscaleImageInput {
  imageUrl: string;
  /** 2 or 4. Without one: 2 on Replicate, 4 on Stability, whose upscaler has one factor. */
  scale?: 2 | 4;
  provider?: 'replicate' | 'stability' | 'auto';
  /** The provider's own model id, without a provider prefix. */
  model?: string;
}

/** The upscaleImage tool's output. */
export interface UpscaleImageOutput {
  /** The upscaled image as a URL: the provider's, or that of the copy this tool saved. */
  image: string;
  provider: string;
  model: string;
  /** The factor the provider applied. */
  scale: number;
  costUSD?: number;
}

/** The upscaleImage tool, on AgentOS's `upscaleImage`. */
export class UpscaleImageTool implements ITool<UpscaleImageInput, UpscaleImageOutput> {
  readonly id = 'tool.upscaleImage';
  readonly name = 'upscaleImage';
  readonly displayName = 'Upscale Image';
  readonly description =
    'Upscale an image with a super-resolution model: 2x or 4x on Replicate; Stability always returns 4x and takes ' +
    'an input of at most 1,048,576 pixels. Returns the image as a URL: the provider\'s, or the file: URL of a copy ' +
    'saved on this machine.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: {
        type: 'string',
        description: 'The source image: an http(s) URL, a data:image URL, or the file: URL of an image this tool saved.',
      },
      scale: { type: 'number', enum: [2, 4], description: 'The upscale factor: 2 or 4 on Replicate (default 2); Stability always gives 4.' },
      provider: {
        type: 'string',
        enum: ['replicate', 'stability', 'auto'],
        description: 'The image provider. auto (default) takes Replicate when it has a key, else Stability.',
      },
      model: { type: 'string', description: "Optional: the provider's own model id, without a provider prefix." },
    },
    required: ['imageUrl'],
  };

  constructor(
    private readonly keys: ProviderKeys,
    /** Where image data is saved; the default is the images directory of the environment. */
    private readonly store: ImageStore = imageStore(),
  ) {}

  async execute(args: UpscaleImageInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<UpscaleImageOutput>> {
    const fail = (error: string) => ({ success: false, error });
    const image = imageSource(args.imageUrl);
    if (!image) return fail(sourceError('imageUrl'));
    const asked = args.scale === undefined || args.scale === null ? undefined : numberOf(args.scale);
    if (args.scale !== undefined && args.scale !== null && asked !== 2 && asked !== 4) return fail('scale must be 2 or 4.');
    const model = optionalString(args.model, 'model');
    if (model.error) return fail(model.error);
    // Replicate first: its upscaler takes the factor. Stability's takes none and returns four times the input.
    const choice = chooseProvider(args.provider, ['replicate', 'stability'], this.keys);
    if (choice.error) return fail(choice.error);
    const { provider, apiKey } = choice;
    const foreign = foreignModelPrefix(model.value, provider);
    if (foreign) return fail(foreign);
    if (provider === 'stability' && asked === 2) {
      return fail("Stability's upscaler returns four times the input: pass scale 4, or use Replicate.");
    }
    const scale = asked ?? (provider === 'stability' ? 4 : 2);
    try {
      const result = await upscaleImage({
        image: await loadImage(image, 'imageUrl', this.store, context),
        scale,
        provider,
        apiKey,
        model: model.value,
      });
      const upscaled = await storeImage(result.image, this.name, this.store, context);
      if (!upscaled) return fail('The provider returned no image.');
      return {
        success: true,
        output: {
          image: upscaled,
          provider: result.provider,
          model: result.model,
          // With no key held, AgentOS chose the provider: Stability's factor is 4 whatever was asked.
          scale: result.provider === 'stability' ? 4 : scale,
          costUSD: result.usage?.costUSD,
        },
      };
    } catch (error) {
      return fail(messageOf(error));
    }
  }
}
