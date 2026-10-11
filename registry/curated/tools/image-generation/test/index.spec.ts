// @ts-nocheck
/**
 * @fileoverview Tests for ImageGenerationService, GenerateImageTool and the
 * pack factory, with AgentOS's `generateImage` mocked: no provider is called.
 * The files the service saves are real, in a directory of the test's own.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ImageGenerationService } from '../src/ImageGenerationService.js';
import createExtensionPack from '../src/index.js';
import { GenerateImageTool } from '../src/tools/generateImage.js';

const { mockGenerateImage } = vi.hoisted(() => ({
  mockGenerateImage: vi.fn(),
}));

vi.mock('@framers/agentos', () => ({
  generateImage: mockGenerateImage,
}));

/** A PNG as far as its first bytes go. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** The images directory of this test file. */
const IMAGES = realpathSync(mkdtempSync(join(tmpdir(), 'image-generation-spec-')));
afterAll(() => rmSync(IMAGES, { recursive: true, force: true }));

/** What AgentOS's generateImage answers for an OpenAI GPT Image model: image data, never a URL. */
const openaiAnswer = (bytes: Buffer = PNG) => ({
  provider: 'openai',
  model: 'gpt-image-2.5-flare',
  created: 123,
  images: [{ base64: bytes.toString('base64'), mimeType: 'image/png', revisedPrompt: 'A majestic mountain at sunset' }],
});

afterEach(() => {
  vi.restoreAllMocks();
  mockGenerateImage.mockReset();
});

describe('ImageGenerationService', () => {
  it('detects configured providers', () => {
    const service = new ImageGenerationService({
      openaiApiKey: 'sk-openai',
      openrouterApiKey: 'sk-openrouter',
      stabilityApiKey: 'sk-stability',
      replicateApiToken: 'r8-token',
    });

    expect(service.hasOpenAI).toBe(true);
    expect(service.hasOpenRouter).toBe(true);
    expect(service.hasStability).toBe(true);
    expect(service.hasReplicate).toBe(true);
    expect(service.hasAnyProvider).toBe(true);
  });

  it('generates on OpenAI with GPT Image 2.5 Flare, with DALL·E 3 settings as that model takes them', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());
    const service = new ImageGenerationService({ openaiApiKey: 'sk-test-openai-key', defaultProvider: 'openai', imageDir: IMAGES });

    const result = await service.generateImage({
      prompt: 'A mountain at sunset',
      size: '1024x1024',
      quality: 'hd',
      style: 'natural',
      // A host's own options: a style here is DALL·E 3's parameter too.
      providerOptions: { openai: { style: 'natural', moderation: 'low' } },
    });

    // `hd` was DALL·E 3's name for `high`; its `style` parameter is not one a
    // GPT Image model takes, so the style goes into the prompt.
    expect(mockGenerateImage).toHaveBeenCalledWith({
      model: 'openai:gpt-image-2.5-flare',
      prompt: 'A mountain at sunset\n\nStyle: natural and realistic.',
      apiKey: 'sk-test-openai-key',
      size: '1024x1024',
      aspectRatio: undefined,
      quality: 'high',
      n: undefined,
      seed: undefined,
      negativePrompt: undefined,
      providerOptions: { openai: { moderation: 'low' } },
    });
    expect(result).toMatchObject({
      revisedPrompt: 'A majestic mountain at sunset',
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
    });
  });

  it('asks a GPT Image model for medium quality and adds no style when the call gives neither', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());
    await new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES }).generateImage({ prompt: 'A cat' });
    await new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES, defaultQuality: 'standard' }).generateImage({ prompt: 'A cat' });
    await new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES, defaultQuality: 'low' }).generateImage({ prompt: 'A cat' });

    expect(mockGenerateImage.mock.calls.map(([options]) => [options.prompt, options.quality, options.providerOptions])).toEqual([
      ['A cat', 'medium', undefined],
      ['A cat', 'medium', undefined],
      ['A cat', 'low', undefined],
    ]);
  });

  it('sends the quality and the style as given to an OpenAI model that is not a GPT Image model', async () => {
    mockGenerateImage.mockResolvedValue({ provider: 'openai', model: 'gateway-image-model', images: [{ url: 'https://images.example/out.png' }] });
    const service = new ImageGenerationService({ openaiApiKey: 'sk-gateway', defaultModel: 'gateway-image-model', imageDir: IMAGES });

    await service.generateImage({ prompt: 'A cat', quality: 'hd', style: 'vivid' });
    await service.generateImage({ prompt: 'A cat' });

    expect(mockGenerateImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'openai:gateway-image-model', prompt: 'A cat', quality: 'hd', providerOptions: { openai: { style: 'vivid' } } }),
    );
    // No style, and no quality, is made up for it.
    expect(mockGenerateImage).toHaveBeenNthCalledWith(2, expect.objectContaining({ quality: undefined, providerOptions: undefined }));
  });

  it('saves the image data a provider returns and gives its file: URL, never the data', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(200_000, 7)]);
    mockGenerateImage.mockResolvedValue(openaiAnswer(big));
    const service = new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES });

    const result = await service.generateImage({ prompt: 'A mountain at sunset' });

    expect(result.url).toMatch(/^file:\/\//);
    const file = fileURLToPath(result.url);
    expect(basename(file)).toMatch(/^agentos-image-[0-9a-f]{32}\.png$/);
    expect(dirname(file)).toBe(join(IMAGES, 'shared'));
    expect(readFileSync(file)).toEqual(big);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });

  it('saves a data URL the same way, and passes a provider URL on as it is', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      provider: 'stability',
      model: 'sd3-large',
      created: 456,
      images: [{ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    mockGenerateImage.mockResolvedValueOnce({
      provider: 'replicate',
      model: 'black-forest-labs/flux-schnell',
      images: [{ url: 'https://replicate.delivery/out.webp' }],
    });
    const service = new ImageGenerationService({ stabilityApiKey: 'sk-stab-test-key', replicateApiToken: 'r8', imageDir: IMAGES });

    const saved = await service.generateImage({
      prompt: 'A futuristic city',
      provider: 'stability',
      negativePrompt: 'blurry',
      providerOptions: { stability: { engine: 'sd3-large', stylePreset: 'photographic', seed: 77 } },
    });
    const linked = await service.generateImage({ prompt: 'A futuristic city', provider: 'replicate' });

    expect(readFileSync(fileURLToPath(saved.url))).toEqual(PNG);
    expect(saved).toMatchObject({ provider: 'stability', model: 'sd3-large' });
    expect(linked.url).toBe('https://replicate.delivery/out.webp');
    expect(mockGenerateImage).toHaveBeenNthCalledWith(1, {
      model: 'stability:stable-image-core',
      prompt: 'A futuristic city',
      apiKey: 'sk-stab-test-key',
      size: '1024x1024',
      aspectRatio: undefined,
      quality: undefined,
      n: undefined,
      seed: undefined,
      negativePrompt: 'blurry',
      providerOptions: { stability: { engine: 'sd3-large', stylePreset: 'photographic', seed: 77 } },
    });
  });

  it('hands the image data to the host\'s saveImage when it gave one, with the call\'s context', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());
    const saveImage = vi.fn(async () => 'https://cdn.host.example/images/1.png');
    const context = { userContext: { userId: 'user-1' } };
    const service = new ImageGenerationService({ openaiApiKey: 'sk-test', saveImage });

    expect((await service.generateImage({ prompt: 'A cat' }, context)).url).toBe('https://cdn.host.example/images/1.png');
    expect(saveImage).toHaveBeenCalledWith({ bytes: PNG, mimeType: 'image/png', tool: 'generate_image', context });

    saveImage.mockResolvedValue(`data:image/png;base64,${PNG.toString('base64')}`);
    await expect(service.generateImage({ prompt: 'A cat' })).rejects.toThrow(
      "The host's saveImage must return an http(s) URL of at most 2,048 characters.",
    );
  });

  it('fails when the provider returns data that is no image, or nothing', async () => {
    const service = new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES });

    mockGenerateImage.mockResolvedValueOnce({ provider: 'openai', model: 'm', images: [{ base64: Buffer.from('<html>').toString('base64') }] });
    await expect(service.generateImage({ prompt: 'A cat' })).rejects.toThrow('not a PNG, JPEG or WebP image');
    mockGenerateImage.mockResolvedValueOnce({ provider: 'openai', model: 'm', images: [{}] });
    await expect(service.generateImage({ prompt: 'A cat' })).rejects.toThrow('returned no image URL or image data');
    mockGenerateImage.mockResolvedValueOnce({ provider: 'openai', model: 'm', images: [] });
    await expect(service.generateImage({ prompt: 'A cat' })).rejects.toThrow('returned no images');
  });

  it('throws helpful API key guidance when a provider is selected without credentials', async () => {
    const service = new ImageGenerationService({});

    await expect(service.generateImage({ prompt: 'test', provider: 'openai' })).rejects.toThrow(
      'https://platform.openai.com/api-keys',
    );
    await expect(service.generateImage({ prompt: 'test', provider: 'stability' })).rejects.toThrow(
      'https://platform.stability.ai/account/keys',
    );
    await expect(service.generateImage({ prompt: 'test', provider: 'replicate' })).rejects.toThrow(
      'https://replicate.com/account/api-tokens',
    );
  });
});

describe('GenerateImageTool', () => {
  const tool = (config: Record<string, unknown> = {}) =>
    new GenerateImageTool(new ImageGenerationService({ openaiApiKey: 'sk-test', imageDir: IMAGES, ...config }));

  it('has correct metadata', () => {
    const generate = tool();
    expect(generate.id).toBe('tool.generate_image');
    expect(generate.name).toBe('generate_image');
    expect(generate.category).toBe('media');
    expect(generate.inputSchema.required).toContain('prompt');
    expect(generate.inputSchema.properties.quality.enum).toEqual(['low', 'medium', 'high', 'auto', 'standard', 'hd']);
    expect(generate.inputSchema.properties.size.enum).toContain('1536x1024');
  });

  it('returns the saved image\'s URL, in the output and in the display text, and no image data', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer(Buffer.concat([PNG, Buffer.alloc(100_000, 5)])));

    const result = await tool().execute({ prompt: 'A cat wearing a hat' });

    expect(result.success).toBe(true);
    expect(result.output.url).toMatch(/^file:\/\/.*agentos-image-[0-9a-f]{32}\.png$/);
    expect(result.output).toMatchObject({ revisedPrompt: 'A majestic mountain at sunset', provider: 'openai', model: 'gpt-image-2.5-flare' });
    expect(result.details.displayText).toContain(result.output.url);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    expect(JSON.stringify(result)).not.toContain('data:');
  });

  it('saves each user\'s images in a directory of that user\'s own', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());
    const generate = tool();

    const first = await generate.execute({ prompt: 'A cat' }, { userContext: { userId: 'user-1' } });
    const second = await generate.execute({ prompt: 'A cat' }, { userContext: { userId: 'user-2' } });
    const again = await generate.execute({ prompt: 'A cat' }, { userContext: { userId: 'user-1' } });

    const scope = (result) => basename(dirname(fileURLToPath(result.output.url)));
    expect(scope(first)).toMatch(/^u-[0-9a-f]{32}$/);
    expect(scope(second)).not.toBe(scope(first));
    expect(scope(again)).toBe(scope(first));
  });

  it('passes on the schema\'s own fields and nothing else the model added', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());

    const result = await tool().execute({
      prompt: 'A cat',
      size: '1536x1024',
      aspectRatio: '3:2',
      quality: 'high',
      seed: '42',
      negativePrompt: ' blurry ',
      // Not in the schema: more images, and fields for the provider's request body.
      n: 10,
      providerOptions: { openai: { extraBody: { n: 10, user: 'someone-else' } }, replicate: { extraBody: { webhook: 'https://example.com/hook' } } },
      apiKey: 'sk-from-the-model',
      baseUrl: 'https://example.com/v1',
    });

    expect(result.success).toBe(true);
    expect(mockGenerateImage).toHaveBeenCalledWith({
      model: 'openai:gpt-image-2.5-flare',
      prompt: 'A cat',
      apiKey: 'sk-test',
      size: '1536x1024',
      aspectRatio: '3:2',
      quality: 'high',
      n: undefined,
      seed: 42,
      negativePrompt: 'blurry',
      providerOptions: undefined,
    });
  });

  it('keeps a model with another provider\'s prefix inside the model id: the provider and its key do not change', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());

    await tool({ replicateApiToken: 'r8-token' }).execute({ prompt: 'A cat', provider: 'openai', model: 'replicate:owner/name' });

    expect(mockGenerateImage).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai:replicate:owner/name', apiKey: 'sk-test' }));
  });

  it.each([
    [{}, 'prompt is required.'],
    [{ prompt: '   ' }, 'prompt is required.'],
    [{ prompt: ['A cat'] }, 'prompt is required.'],
    [{ prompt: 'A cat', quality: 'ultra' }, 'quality must be one of low, medium, high, auto, standard, hd.'],
    [{ prompt: 'A cat', style: 'cubist' }, 'style must be one of vivid, natural.'],
    [{ prompt: 'A cat', provider: 'midjourney' }, 'provider must be one of openai, openrouter, stability, replicate.'],
    [{ prompt: 'A cat', size: 1024 }, 'size must be one of 1024x1024, 1536x1024, 1024x1536, 1792x1024, 1024x1792.'],
    [{ prompt: 'A cat', size: '800x800' }, 'size must be one of 1024x1024, 1536x1024, 1024x1536, 1792x1024, 1024x1792.'],
    [{ prompt: 'A cat', model: { id: 'x' } }, 'model must be a string.'],
    [{ prompt: 'A cat', seed: 'lucky' }, 'seed must be a number.'],
  ])('refuses %j before any provider is called', async (args, error) => {
    const result = await tool().execute(args);

    expect(result).toEqual({ success: false, error });
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('returns failure with error message on API error', async () => {
    mockGenerateImage.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await tool().execute({ prompt: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limit exceeded');
  });

  it('returns apiKeyGuidance in details when API key missing', async () => {
    const result = await new GenerateImageTool(new ImageGenerationService({})).execute({ prompt: 'test', provider: 'openai' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OPENAI_API_KEY');
    expect(result.details).toBeDefined();
    expect((result.details as Record<string, unknown>).apiKeyGuidance).toBeDefined();
  });
});

describe('the pack', () => {
  it('registers generate_image with the package\'s own version, and saves where its options say', async () => {
    mockGenerateImage.mockResolvedValue(openaiAnswer());
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'image-generation-pack-')));
    try {
      const pack = createExtensionPack({ options: { openaiApiKey: 'sk-test', imageDir: dir } });
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

      expect(pack.version).toBe(version);
      expect(pack.descriptors.map((descriptor) => descriptor.id)).toEqual(['generate_image']);
      const result = await pack.descriptors[0].payload.execute({ prompt: 'A cat' });
      expect(dirname(dirname(fileURLToPath(result.output.url)))).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
