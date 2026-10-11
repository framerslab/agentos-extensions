// @ts-nocheck
/**
 * @fileoverview The editImage tool: img2img and inpainting through AgentOS's
 * `editImage`.
 */

import { editImage } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import {
  checkImageStore,
  chooseProvider,
  foreignModelPrefix,
  imageSource,
  imageStore,
  keepImage,
  loadImage,
  messageOf,
  numberOf,
  optionalString,
  sourceError,
  storeImage,
  type ImageStore,
  type ProviderKeys,
} from '../shared.js';

/** The editImage tool's input. Every image is a data:image URL, an http(s) URL on a public host, or the file: URL of an image this tool saved. */
export interface EditImageInput {
  /** The source image. */
  imageUrl: string;
  /** The change to make, in words. */
  prompt: string;
  /** `img2img`, or `inpaint` (needs `maskUrl`). Without one: `inpaint` when a `maskUrl` is given, else `img2img`. */
  mode?: 'img2img' | 'inpaint';
  /** For inpaint: a mask whose white pixels mark the regions to repaint. */
  maskUrl?: string;
  /** How far to move from the source, 0 to 1 (default 0.75); clamped. */
  strength?: number;
  /** The provider; `auto` (default) takes the first with a key. */
  provider?: 'openai' | 'stability' | 'replicate' | 'auto';
  /** The provider's own model id, such as `gpt-image-2.5-sunburst`, without a provider prefix. */
  model?: string;
  /** Output size, such as `1024x1024`. */
  size?: string;
  /** Content to avoid. */
  negativePrompt?: string;
}

/** The editImage tool's output. */
export interface EditImageOutput {
  /** Each edited image as the URL of the copy this tool saved (the provider's own URL when it could not be copied: see `notes`). */
  images: string[];
  provider: string;
  model: string;
  costUSD?: number;
  /** One line for each image returned at the provider's own URL because it could not be copied; that URL may stop working (Replicate deletes its output files after an hour). */
  notes?: string[];
}

/** The modes the tool runs. */
const MODES = ['img2img', 'inpaint'];

/**
 * Why `style-transfer` is refused. AgentOS's `transferStyle` sends no
 * provider both images: with a provider named (the tool names one whenever
 * it holds a key) it runs an img2img of the source by the prompt and drops
 * the style image, and its Flux Redux route on Replicate makes a variation of
 * the style image and drops the source.
 */
const NO_STYLE_TRANSFER =
  'style-transfer is not available: no provider route sends both the source image and the style image. Use img2img and describe the style in the prompt.';

/** The editImage tool, on AgentOS's `editImage`. */
export class EditImageTool implements ITool<EditImageInput, EditImageOutput> {
  readonly id = 'tool.editImage';
  readonly name = 'editImage';
  readonly displayName = 'Edit Image';
  readonly description =
    'Edit an image: img2img transformation by a prompt, or inpainting of the white regions of a mask. ' +
    'Returns each edited image as a URL: the provider\'s, ' +
    'or the file: URL of a copy saved on this machine, which these tools accept as a source.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: {
        type: 'string',
        description: 'The source image: an http(s) URL, a data:image URL, or the file: URL of an image this tool saved.',
      },
      prompt: { type: 'string', description: 'The change to make, in words.' },
      mode: {
        type: 'string',
        enum: MODES,
        description: 'img2img, or inpaint (needs maskUrl). Without a mode: inpaint when maskUrl is given, else img2img.',
      },
      maskUrl: { type: 'string', description: 'For inpaint: a mask image whose white pixels mark the regions to repaint.' },
      strength: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How far to move from the source, 0 to 1 (default 0.75). Stability and Replicate take it; OpenAI does not.',
      },
      provider: {
        type: 'string',
        enum: ['openai', 'stability', 'replicate', 'auto'],
        description: 'The image provider. auto (default) takes the first one with a key.',
      },
      model: { type: 'string', description: "Optional: the provider's own model id, such as gpt-image-2.5-sunburst, without a provider prefix." },
      size: { type: 'string', description: 'Optional output size, such as 1024x1024. OpenAI takes it; Stability and Replicate do not.' },
      negativePrompt: { type: 'string', description: 'Optional content to avoid. Stability and Replicate take it; OpenAI does not.' },
    },
    required: ['imageUrl', 'prompt'],
  };

  constructor(
    private readonly keys: ProviderKeys,
    /** Where image data is saved; the default is the images directory of the environment. */
    private readonly store: ImageStore = imageStore(),
  ) {}

  async execute(args: EditImageInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<EditImageOutput>> {
    const fail = (error: string) => ({ success: false, error });
    // Every argument is checked before an image is fetched or a provider is
    // called: the model can send values the input schema does not allow.
    const maskGiven = args.maskUrl !== undefined && args.maskUrl !== null;
    // A mask given with no mode asks for inpainting; given with img2img it
    // would be dropped without a word.
    const mode = args.mode ?? (maskGiven ? 'inpaint' : 'img2img');
    if (mode === 'outpaint') {
      return fail('outpaint is not available: no provider route extends an image. Use img2img, or inpaint with a mask.');
    }
    if (mode === 'style-transfer' || (args.styleImageUrl !== undefined && args.styleImageUrl !== null)) {
      return fail(NO_STYLE_TRANSFER);
    }
    if (!MODES.includes(mode)) return fail(`mode must be one of ${MODES.join(', ')}.`);
    if (maskGiven && mode !== 'inpaint') return fail('maskUrl is read only with mode inpaint.');
    const image = imageSource(args.imageUrl);
    if (!image) return fail(sourceError('imageUrl'));
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return fail('prompt is required.');
    const mask = mode === 'inpaint' ? imageSource(args.maskUrl) : undefined;
    if (mode === 'inpaint' && !mask) return fail(`inpaint needs maskUrl. ${sourceError('maskUrl')}`);
    let strength: number | undefined;
    if (args.strength !== undefined && args.strength !== null) {
      const given = numberOf(args.strength);
      if (given === undefined) return fail('strength must be a number from 0 to 1.');
      strength = Math.min(1, Math.max(0, given));
    }
    const model = optionalString(args.model, 'model');
    const size = optionalString(args.size, 'size');
    const negativePrompt = optionalString(args.negativePrompt, 'negativePrompt');
    const invalid = model.error ?? size.error ?? negativePrompt.error;
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
      const [imageInput, maskInput] = await Promise.all([
        loadImage(image, 'imageUrl', this.store, context),
        mask && loadImage(mask, 'maskUrl', this.store, context),
      ]);
      const result = await editImage({
        image: imageInput,
        prompt: args.prompt,
        mode,
        mask: maskInput,
        strength,
        provider,
        apiKey,
        model: model.value,
        size: size.value,
        negativePrompt: negativePrompt.value,
      });
      const images: string[] = [];
      const notes: string[] = [];
      for (const edited of result.images ?? []) {
        const reference = await storeImage(edited, this.name, this.store, context, keepImage(notes));
        if (reference) images.push(reference);
      }
      if (images.length === 0) return fail('The provider returned no image.');
      return {
        success: true,
        output: {
          images,
          provider: result.provider,
          model: result.model,
          costUSD: result.usage?.costUSD,
          ...(notes.length ? { notes } : {}),
        },
      };
    } catch (error) {
      return fail(messageOf(error));
    }
  }
}
