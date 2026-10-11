// @ts-nocheck
/**
 * @fileoverview The variateImage tool: variations of an image through
 * AgentOS's `variateImage`.
 */

import { variateImage } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import {
  checkImageStore,
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

/** The variateImage tool's input. The image is a data:image URL, an http(s) URL on a public host, or the file: URL of an image this tool saved. */
export interface VariateImageInput {
  imageUrl: string;
  count?: number;
  provider?: 'openai' | 'stability' | 'replicate' | 'auto';
  /** The provider's own model id, without a provider prefix. */
  model?: string;
  size?: string;
}

/** The variateImage tool's output. */
export interface VariateImageOutput {
  /** Each variation as a URL: the provider's, or that of the copy this tool saved. */
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
  readonly description =
    'Generate variations of an existing image. Returns each variation as a URL: the provider\'s, or the file: URL ' +
    'of a copy saved on this machine.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: {
        type: 'string',
        description: 'The source image: an http(s) URL, a data:image URL, or the file: URL of an image this tool saved.',
      },
      count: { type: 'number', minimum: 1, maximum: MAX_VARIATIONS, description: `How many variations (default 1, at most ${MAX_VARIATIONS}).` },
      provider: {
        type: 'string',
        enum: ['openai', 'stability', 'replicate', 'auto'],
        description: 'The image provider. auto (default) takes the first one with a key.',
      },
      model: { type: 'string', description: "Optional: the provider's own model id, without a provider prefix." },
      size: { type: 'string', description: 'Optional output size, such as 1024x1024.' },
    },
    required: ['imageUrl'],
  };

  constructor(
    private readonly keys: ProviderKeys,
    /** Where image data is saved; the default is the images directory of the environment. */
    private readonly store: ImageStore = imageStore(),
  ) {}

  async execute(args: VariateImageInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<VariateImageOutput>> {
    const fail = (error: string) => ({ success: false, error });
    const image = imageSource(args.imageUrl);
    if (!image) return fail(sourceError('imageUrl'));
    let n = 1;
    if (args.count !== undefined && args.count !== null) {
      const count = numberOf(args.count);
      if (count === undefined) return fail(`count must be a number from 1 to ${MAX_VARIATIONS}.`);
      n = Math.min(MAX_VARIATIONS, Math.max(1, Math.floor(count)));
    }
    const model = optionalString(args.model, 'model');
    const size = optionalString(args.size, 'size');
    const invalid = model.error ?? size.error;
    if (invalid) return fail(invalid);
    const choice = chooseProvider(args.provider, ['openai', 'stability', 'replicate'], this.keys);
    if (choice.error) return fail(choice.error);
    const { provider, apiKey } = choice;
    const foreign = foreignModelPrefix(model.value, provider);
    if (foreign) return fail(foreign);
    try {
      // Before anything is fetched or billed: a directory the saver refuses.
      // Replicate too: AgentOS asks it in sync mode, where it can answer with
      // a data: URL, which is saved like any other image data.
      await checkImageStore(this.store, context);
      const result = await variateImage({
        image: await loadImage(image, 'imageUrl', this.store, context),
        n,
        provider,
        apiKey,
        model: model.value,
        size: size.value,
      });
      const images: string[] = [];
      for (const variation of result.images ?? []) {
        const reference = await storeImage(variation, this.name, this.store, context);
        if (reference) images.push(reference);
      }
      if (images.length === 0) return fail('The provider returned no image.');
      return { success: true, output: { images, provider: result.provider, model: result.model, costUSD: result.usage?.costUSD } };
    } catch (error) {
      return fail(messageOf(error));
    }
  }
}
