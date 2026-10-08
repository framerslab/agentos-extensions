// @ts-nocheck
/**
 * @fileoverview The image-editing tools through the pack factory, with AgentOS's
 * image functions mocked: no provider is called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentos = vi.hoisted(() => ({
  editImage: vi.fn(),
  transferStyle: vi.fn(),
  upscaleImage: vi.fn(),
  variateImage: vi.fn(),
}));

vi.mock('@framers/agentos', () => agentos);

import { createExtensionPack } from '../src/index.js';

const SOURCE = 'https://example.com/photo.png';

/** The pack's tools by name, made from these secrets and options. */
function tools(secrets: Record<string, string> = {}, options: Record<string, unknown> = {}) {
  const pack = createExtensionPack({ getSecret: (id: string) => secrets[id], options });
  return Object.fromEntries(pack.descriptors.map((descriptor) => [descriptor.id, descriptor.payload]));
}

// The pack falls back to these environment variables; each test sets its keys itself.
const KEY_VARS = ['OPENAI_API_KEY', 'STABILITY_API_KEY', 'REPLICATE_API_TOKEN'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of KEY_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const fn of Object.values(agentos)) fn.mockReset();
  for (const name of KEY_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe('the pack', () => {
  it('registers editImage, upscaleImage and variateImage under their tool names, with schemas', () => {
    const pack = createExtensionPack({});
    expect(pack.descriptors.map((descriptor) => descriptor.id)).toEqual(['editImage', 'upscaleImage', 'variateImage']);
    for (const descriptor of pack.descriptors) {
      expect(descriptor.payload.name).toBe(descriptor.id);
      expect(descriptor.payload.inputSchema.required).toContain('imageUrl');
    }
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('editImage', () => {
  it('edits through AgentOS with the provider that has a key, and returns image links', async () => {
    agentos.editImage.mockResolvedValue({
      images: [{ url: 'https://cdn.example.com/out.png' }, { base64: 'aGVsbG8=', mimeType: 'image/webp' }],
      provider: 'stability',
      model: 'sd3-medium',
      usage: { costUSD: 0.04 },
    });

    const result = await tools({ 'stability.apiKey': 'sk-stability' }).editImage.execute({
      imageUrl: SOURCE,
      prompt: 'make it a watercolor',
      strength: 1.7,
    });

    expect(agentos.editImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: SOURCE,
        prompt: 'make it a watercolor',
        mode: 'img2img',
        strength: 1,
        provider: 'stability',
        apiKey: 'sk-stability',
      }),
    );
    expect(result).toEqual({
      success: true,
      output: {
        images: ['https://cdn.example.com/out.png', 'data:image/webp;base64,aGVsbG8='],
        provider: 'stability',
        model: 'sd3-medium',
        costUSD: 0.04,
      },
    });
  });

  it('sends the mask for inpainting, and refuses inpainting without one', async () => {
    agentos.editImage.mockResolvedValue({ images: [{ url: 'https://cdn.example.com/out.png' }], provider: 'openai', model: 'gpt-image-1', usage: {} });
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });

    const missing = await editImage.execute({ imageUrl: SOURCE, prompt: 'remove the car', mode: 'inpaint' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('maskUrl');
    expect(agentos.editImage).not.toHaveBeenCalled();

    const done = await editImage.execute({ imageUrl: SOURCE, prompt: 'remove the car', mode: 'inpaint', maskUrl: 'data:image/png;base64,AAAA' });
    expect(done.success).toBe(true);
    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inpaint', mask: 'data:image/png;base64,AAAA', provider: 'openai' }));
  });

  it('runs style transfer through transferStyle with the style image', async () => {
    agentos.transferStyle.mockResolvedValue({ images: [{ url: 'https://cdn.example.com/styled.png' }], provider: 'replicate', model: 'ip-adapter', usage: {} });
    const { editImage } = tools();

    const missing = await editImage.execute({ imageUrl: SOURCE, prompt: 'in this style', mode: 'style-transfer' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('styleImageUrl');

    const done = await editImage.execute({
      imageUrl: SOURCE,
      prompt: 'in this style',
      mode: 'style-transfer',
      styleImageUrl: 'https://example.com/style.png',
    });
    expect(done.output.images).toEqual(['https://cdn.example.com/styled.png']);
    expect(agentos.transferStyle).toHaveBeenCalledWith(
      expect.objectContaining({ image: SOURCE, styleReference: 'https://example.com/style.png', prompt: 'in this style' }),
    );
    expect(agentos.editImage).not.toHaveBeenCalled();
  });

  it('reads no local file: a path is refused before any provider is called', async () => {
    for (const imageUrl of ['/etc/hosts', 'file:///etc/hosts', '../secret.png', 'C:\\keys\\photo.png']) {
      const result = await tools({ 'openai.apiKey': 'sk-openai' }).editImage.execute({ imageUrl, prompt: 'x' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('local file paths are not read');
    }
    expect(agentos.editImage).not.toHaveBeenCalled();
  });

  it('leaves the provider to AgentOS when no key is configured, and reports its error', async () => {
    agentos.editImage.mockRejectedValue(new Error('No image provider configured.'));
    const result = await tools().editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ provider: undefined, apiKey: undefined }));
    expect(result).toEqual({ success: false, error: 'No image provider configured.' });
  });

  it('takes the key from the environment when no secret or option gives one', async () => {
    process.env.REPLICATE_API_TOKEN = 'r8-env';
    agentos.editImage.mockResolvedValue({ images: [{ url: 'https://cdn.example.com/out.png' }], provider: 'replicate', model: 'sdxl', usage: {} });
    await tools().editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'replicate', apiKey: 'r8-env' }));
  });
});

describe('upscaleImage', () => {
  it('upscales 4x with the provider named, and its key from the options', async () => {
    agentos.upscaleImage.mockResolvedValue({ image: { url: 'https://cdn.example.com/big.png' }, provider: 'replicate', model: 'real-esrgan', usage: {} });
    const result = await tools({}, { replicateApiToken: 'r8-token' }).upscaleImage.execute({ imageUrl: SOURCE, scale: 4, provider: 'replicate' });

    expect(agentos.upscaleImage).toHaveBeenCalledWith(expect.objectContaining({ image: SOURCE, scale: 4, provider: 'replicate', apiKey: 'r8-token' }));
    expect(result.output.image).toBe('https://cdn.example.com/big.png');
  });
});

describe('variateImage', () => {
  it('asks for at most four variations', async () => {
    agentos.variateImage.mockResolvedValue({ images: [{ url: 'https://cdn.example.com/v1.png' }], provider: 'openai', model: 'dall-e-2', usage: {} });
    await tools({ 'openai.apiKey': 'sk-openai' }).variateImage.execute({ imageUrl: SOURCE, count: 9 });

    expect(agentos.variateImage).toHaveBeenCalledWith(expect.objectContaining({ n: 4, provider: 'openai', apiKey: 'sk-openai' }));
  });
});
