// @ts-nocheck
/**
 * @fileoverview Image generation service backed by AgentOS's shared
 * provider-agnostic image API.
 *
 * Image data a provider returns is saved and the result carries the saved
 * copy's URL, never the data: see `imageFiles.ts`.
 */

import { generateImage, type ImageProviderOptionBag } from '@framers/agentos';

import { checkImageStore, imageStore, storeImage, type ImageStore, type SaveImage } from './imageFiles.js';

export type ImageGenerationProvider = 'openai' | 'openrouter' | 'stability' | 'replicate';

/**
 * The quality of an image. OpenAI's GPT Image models take `low`, `medium`,
 * `high` and `auto`; `standard` and `hd` were DALL·E 3's names and are sent
 * to them as `medium` and `high`.
 */
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto' | 'standard' | 'hd';

/**
 * OpenAI's model for making an image from a prompt. OpenAI shut down
 * `dall-e-2` and `dall-e-3` on 2026-05-12, and shuts down `gpt-image-1` on
 * 2026-10-23 and `gpt-image-1.5` on 2026-12-01
 * (https://developers.openai.com/api/docs/deprecations).
 */
const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-flare';

/** Whether `model` names one of OpenAI's GPT Image models. */
function isGptImageModel(model: string): boolean {
  return /^(gpt-image-|chatgpt-image-)/.test(model);
}

/**
 * What a GPT Image model is told for a style, in the prompt: it takes no
 * `style` parameter, which was DALL·E 3's.
 */
const STYLE_SENTENCE: Record<'vivid' | 'natural', string> = {
  vivid: 'Style: vivid, hyper-real and dramatic.',
  natural: 'Style: natural and realistic.',
};

export interface ImageGenerationConfig {
  openaiApiKey?: string;
  openrouterApiKey?: string;
  stabilityApiKey?: string;
  replicateApiToken?: string;
  defaultProvider?: ImageGenerationProvider;
  defaultModel?: string;
  defaultSize?: string;
  defaultQuality?: ImageQuality;
  /**
   * Where image data a provider returns is saved (else `AGENTOS_IMAGE_DIR`,
   * else a folder in the user's temp directory).
   */
  imageDir?: string;
  /** Stores image data in place of the default saver and returns the http(s) URL the host's clients load. */
  saveImage?: SaveImage;
}

export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  aspectRatio?: string;
  quality?: ImageQuality;
  style?: 'vivid' | 'natural';
  n?: number;
  provider?: ImageGenerationProvider;
  model?: string;
  seed?: number;
  negativePrompt?: string;
  providerOptions?: ImageProviderOptionBag | Record<string, unknown>;
}

export interface GeneratedImage {
  /** The provider's image URL, or the URL of the copy that was saved of the image data it returned. */
  url: string;
  revisedPrompt?: string;
  provider: string;
  model: string;
  size: string;
}

const PROVIDER_DOCS_URL: Record<ImageGenerationProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys',
  stability: 'https://platform.stability.ai/account/keys',
  replicate: 'https://replicate.com/account/api-tokens',
};

export class ImageGenerationService {
  private readonly config: ImageGenerationConfig;
  private readonly store: ImageStore;
  private initialized = false;

  constructor(config: ImageGenerationConfig) {
    this.config = config;
    this.store = imageStore(config);
  }

  get hasOpenAI(): boolean {
    return !!this.config.openaiApiKey;
  }

  get hasOpenRouter(): boolean {
    return !!this.config.openrouterApiKey;
  }

  get hasStability(): boolean {
    return !!this.config.stabilityApiKey;
  }

  get hasReplicate(): boolean {
    return !!this.config.replicateApiToken;
  }

  get hasAnyProvider(): boolean {
    return this.hasOpenAI || this.hasOpenRouter || this.hasStability || this.hasReplicate;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * Generates one image.
   *
   * @param options - The prompt and its settings.
   * @param context - The tool call's context, when there is one: image data
   *   is saved in the calling user's own subdirectory and handed to a host's
   *   `saveImage` with it.
   */
  async generateImage(options: GenerateImageOptions, context?: unknown): Promise<GeneratedImage> {
    const provider = this.resolveProvider(options.provider);
    const apiKey = this.getApiKey(provider);
    if (!apiKey) {
      const envVar = provider === 'replicate' ? 'REPLICATE_API_TOKEN' : `${provider.toUpperCase()}_API_KEY`;
      throw new Error(
        `${envVar} is required for ${this.displayNameForProvider(provider)} image generation. `
        + `Set it in your environment or .env file. Get one at ${PROVIDER_DOCS_URL[provider]}`,
      );
    }

    // Before the provider bills for an image: a directory the saver refuses.
    // Replicate answers with URLs, returned as they are, so it needs none.
    if (provider !== 'replicate') await checkImageStore(this.store, context);

    const model = options.model || this.config.defaultModel || this.defaultModelForProvider(provider);
    // A GPT Image model takes neither DALL·E 3's quality names nor its
    // `style` parameter: the names are rewritten, and a style goes into the
    // prompt.
    const gptImage = provider === 'openai' && isGptImageModel(model);
    const quality = options.quality || this.config.defaultQuality;
    const style = gptImage && options.style ? STYLE_SENTENCE[options.style] : undefined;
    const result = await generateImage({
      model: `${provider}:${model}`,
      prompt: style ? `${options.prompt}\n\n${style}` : options.prompt,
      apiKey,
      size: options.size || this.config.defaultSize || '1024x1024',
      aspectRatio: options.aspectRatio,
      quality: gptImage ? gptImageQuality(quality) : quality,
      n: options.n,
      seed: options.seed,
      negativePrompt: options.negativePrompt,
      providerOptions: this.normalizeProviderOptions(provider, options, gptImage),
    });

    const first = result.images?.[0];
    if (!first) {
      throw new Error('Image generation returned no images.');
    }

    const url = await storeImage(first, 'generate_image', this.store, context);
    if (!url) {
      throw new Error('Image generation returned no image URL or image data.');
    }

    return {
      url,
      revisedPrompt: first.revisedPrompt,
      provider: result.provider,
      model: result.model,
      size: options.size || this.config.defaultSize || '1024x1024',
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  private resolveProvider(provider?: ImageGenerationProvider): ImageGenerationProvider {
    if (provider) {
      return provider;
    }
    if (this.config.defaultProvider) {
      return this.config.defaultProvider;
    }
    if (this.hasOpenAI) return 'openai';
    if (this.hasOpenRouter) return 'openrouter';
    if (this.hasStability) return 'stability';
    if (this.hasReplicate) return 'replicate';
    return 'openai';
  }

  private getApiKey(provider: ImageGenerationProvider): string | undefined {
    switch (provider) {
      case 'openai':
        return this.config.openaiApiKey;
      case 'openrouter':
        return this.config.openrouterApiKey;
      case 'stability':
        return this.config.stabilityApiKey;
      case 'replicate':
        return this.config.replicateApiToken;
      default:
        return undefined;
    }
  }

  private defaultModelForProvider(provider: ImageGenerationProvider): string {
    switch (provider) {
      case 'openai':
        return OPENAI_IMAGE_MODEL;
      case 'openrouter':
        return 'google/gemini-2.5-flash-image';
      case 'stability':
        return 'stable-image-core';
      case 'replicate':
        return 'black-forest-labs/flux-schnell';
      default:
        return OPENAI_IMAGE_MODEL;
    }
  }

  private displayNameForProvider(provider: ImageGenerationProvider): string {
    switch (provider) {
      case 'openai':
        return 'OpenAI';
      case 'openrouter':
        return 'OpenRouter';
      case 'stability':
        return 'Stability AI';
      case 'replicate':
        return 'Replicate';
      default:
        return provider;
    }
  }

  /**
   * The provider options of a call. A `style` goes to an OpenAI model that
   * is not a GPT Image model (one behind a gateway) as its `style` parameter;
   * a GPT Image model is sent none, from the call or from the options.
   */
  private normalizeProviderOptions(
    provider: ImageGenerationProvider,
    options: GenerateImageOptions,
    gptImage: boolean,
  ): ImageProviderOptionBag | Record<string, unknown> | undefined {
    const given =
      options.providerOptions && typeof options.providerOptions === 'object' && !Array.isArray(options.providerOptions)
        ? { ...options.providerOptions }
        : undefined;
    if (provider !== 'openai') return given;
    if (gptImage) {
      if (!given?.openai || typeof given.openai !== 'object') return given;
      const { style: _style, ...openai } = given.openai;
      return { ...given, openai };
    }
    if (!options.style) return given;
    return { ...(given ?? {}), openai: { ...(given?.openai ?? {}), style: options.style } };
  }
}

/** The quality a GPT Image model is sent: `medium` when none is given, and for DALL·E 3's `standard`; `high` for its `hd`. */
function gptImageQuality(quality: ImageQuality | undefined): ImageQuality {
  if (!quality || quality === 'standard') return 'medium';
  return quality === 'hd' ? 'high' : quality;
}
