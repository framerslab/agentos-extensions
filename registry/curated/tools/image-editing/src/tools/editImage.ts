// @ts-nocheck
/**
 * @fileoverview The editImage tool: img2img, inpainting, outpainting and
 * style transfer through AgentOS's `editImage` and `transferStyle`.
 */

import { editImage, transferStyle } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import { chooseProvider, imageLink, imageSource, loadImage, messageOf, sourceError, type ProviderKeys } from '../shared.js';

/** The editImage tool's input. Every image is a data:image URL or an http(s) URL on a public host. */
export interface EditImageInput {
  /** The source image. */
  imageUrl: string;
  /** The change to make, in words. */
  prompt: string;
  /** `img2img` (default), `inpaint` (needs `maskUrl`), `outpaint`, or `style-transfer` (needs `styleImageUrl`). */
  mode?: 'img2img' | 'inpaint' | 'outpaint' | 'style-transfer';
  /** For inpaint: a mask whose white pixels mark the regions to repaint. */
  maskUrl?: string;
  /** For style-transfer: the image whose style to apply. */
  styleImageUrl?: string;
  /** How far to move from the source, 0 to 1 (default 0.75); clamped. */
  strength?: number;
  /** The provider; `auto` (default) takes the first with a key. */
  provider?: 'openai' | 'stability' | 'replicate' | 'auto';
  /** A provider model id, such as `gpt-image-1`. */
  model?: string;
  /** Output size, such as `1024x1024`. */
  size?: string;
  /** Content to avoid. */
  negativePrompt?: string;
}

/** The editImage tool's output. */
export interface EditImageOutput {
  /** Each edited image as a URL, or a data URL when the provider returned image data. */
  images: string[];
  provider: string;
  model: string;
  costUSD?: number;
}

/** The editImage tool, on AgentOS's `editImage` and, for style transfer, `transferStyle`. */
export class EditImageTool implements ITool<EditImageInput, EditImageOutput> {
  readonly id = 'tool.editImage';
  readonly name = 'editImage';
  readonly displayName = 'Edit Image';
  readonly description =
    'Edit an image: img2img transformation by a prompt, inpainting of the white regions of a mask, ' +
    'outpainting beyond its borders, or style transfer from a second image. Returns the edited images as URLs.';
  readonly category = 'media';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      imageUrl: { type: 'string', description: 'The source image: an http(s) URL or a data:image URL.' },
      prompt: { type: 'string', description: 'The change to make, in words.' },
      mode: {
        type: 'string',
        enum: ['img2img', 'inpaint', 'outpaint', 'style-transfer'],
        description: 'img2img (default), inpaint (needs maskUrl), outpaint, or style-transfer (needs styleImageUrl).',
      },
      maskUrl: { type: 'string', description: 'For inpaint: a mask image whose white pixels mark the regions to repaint.' },
      styleImageUrl: { type: 'string', description: 'For style-transfer: the image whose style to apply.' },
      strength: { type: 'number', minimum: 0, maximum: 1, description: 'How far to move from the source, 0 to 1 (default 0.75).' },
      provider: {
        type: 'string',
        enum: ['openai', 'stability', 'replicate', 'auto'],
        description: 'The image provider. auto (default) takes the first one with a key.',
      },
      model: { type: 'string', description: "Optional provider model id, such as gpt-image-1." },
      size: { type: 'string', description: 'Optional output size, such as 1024x1024.' },
      negativePrompt: { type: 'string', description: 'Optional content to avoid.' },
    },
    required: ['imageUrl', 'prompt'],
  };

  constructor(private readonly keys: ProviderKeys) {}

  async execute(args: EditImageInput, _context?: ToolExecutionContext): Promise<ToolExecutionResult<EditImageOutput>> {
    const mode = args.mode ?? 'img2img';
    const image = imageSource(args.imageUrl);
    if (!image) return { success: false, error: sourceError('imageUrl') };
    if (!args.prompt?.trim()) return { success: false, error: 'prompt is required.' };
    const mask = mode === 'inpaint' ? imageSource(args.maskUrl) : undefined;
    if (mode === 'inpaint' && !mask) {
      return { success: false, error: `inpaint needs maskUrl. ${sourceError('maskUrl')}` };
    }
    const style = mode === 'style-transfer' ? imageSource(args.styleImageUrl) : undefined;
    if (mode === 'style-transfer' && !style) {
      return { success: false, error: `style-transfer needs styleImageUrl. ${sourceError('styleImageUrl')}` };
    }
    const strength = typeof args.strength === 'number' ? Math.min(1, Math.max(0, args.strength)) : undefined;
    const choice = chooseProvider(args.provider, ['openai', 'stability', 'replicate'], this.keys);
    if (choice.error) return { success: false, error: choice.error };
    const { provider, apiKey } = choice;

    try {
      const [imageInput, maskInput, styleInput] = await Promise.all([
        loadImage(image),
        mask && loadImage(mask),
        style && loadImage(style),
      ]);
      const result =
        mode === 'style-transfer'
          ? // AgentOS before transferStyle took apiKey ignores it and reads the key from the environment.
            await transferStyle({
              image: imageInput,
              styleReference: styleInput,
              prompt: args.prompt,
              strength,
              provider,
              apiKey,
              model: args.model,
              size: args.size,
              negativePrompt: args.negativePrompt,
            })
          : await editImage({
              image: imageInput,
              prompt: args.prompt,
              mode,
              mask: maskInput,
              strength,
              provider,
              apiKey,
              model: args.model,
              size: args.size,
              negativePrompt: args.negativePrompt,
            });
      const images = (result.images ?? []).map(imageLink).filter(Boolean);
      if (images.length === 0) return { success: false, error: 'The provider returned no image.' };
      return {
        success: true,
        output: { images, provider: result.provider, model: result.model, costUSD: result.usage?.costUSD },
      };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }
}
