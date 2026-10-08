// @ts-nocheck
/**
 * @fileoverview The editImage tool: img2img, inpainting, outpainting and
 * style transfer through AgentOS's `editImage` and `transferStyle`.
 */

import { editImage, transferStyle } from '@framers/agentos';
import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import { chooseProvider, imageLink, isImageSource, messageOf, sourceError, type ProviderKeys } from '../shared.js';

export interface EditImageInput {
  imageUrl: string;
  prompt: string;
  mode?: 'img2img' | 'inpaint' | 'outpaint' | 'style-transfer';
  maskUrl?: string;
  styleImageUrl?: string;
  strength?: number;
  provider?: 'openai' | 'stability' | 'replicate' | 'auto';
  model?: string;
  size?: string;
  negativePrompt?: string;
}

export interface EditImageOutput {
  /** Each edited image as a URL, or a data URL when the provider returned image data. */
  images: string[];
  provider: string;
  model: string;
  costUSD?: number;
}

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
    if (!isImageSource(args.imageUrl)) return { success: false, error: sourceError('imageUrl') };
    if (!args.prompt?.trim()) return { success: false, error: 'prompt is required.' };
    if (mode === 'inpaint' && !isImageSource(args.maskUrl)) {
      return { success: false, error: `inpaint needs maskUrl. ${sourceError('maskUrl')}` };
    }
    if (mode === 'style-transfer' && !isImageSource(args.styleImageUrl)) {
      return { success: false, error: `style-transfer needs styleImageUrl. ${sourceError('styleImageUrl')}` };
    }
    const strength = typeof args.strength === 'number' ? Math.min(1, Math.max(0, args.strength)) : undefined;
    const { provider, apiKey } = chooseProvider(args.provider, ['openai', 'stability', 'replicate'], this.keys);

    try {
      const result =
        mode === 'style-transfer'
          ? // transferStyle takes no API key: its provider reads its key from the environment.
            await transferStyle({
              image: args.imageUrl,
              styleReference: args.styleImageUrl,
              prompt: args.prompt,
              strength,
              provider,
              model: args.model,
              size: args.size,
              negativePrompt: args.negativePrompt,
            })
          : await editImage({
              image: args.imageUrl,
              prompt: args.prompt,
              mode,
              mask: mode === 'inpaint' ? args.maskUrl : undefined,
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
