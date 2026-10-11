// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool through the pack factory, with
 * AgentOS's createVisionPipeline mocked: no OCR engine, model or cloud
 * provider runs.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// isPublicNetworkAddress is set, as in an AgentOS that has imageToBuffer's untrusted mode (0.13.16 and later).
const agentos = vi.hoisted(() => ({
  createVisionPipeline: vi.fn(),
  imageToBuffer: vi.fn(),
  isPublicNetworkAddress: vi.fn(() => true),
}));
vi.mock('@framers/agentos', () => agentos);

import { saveImageFile, scopeOf } from '../src/imageFiles.js';
import { createExtensionPack, imageInput } from '../src/index.js';

const SOURCE = 'https://example.com/receipt.png';
/** A PNG as far as its first bytes go. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
/** What the mocked AgentOS gives for a fetched http(s) image. */
const FETCHED = Buffer.concat([PNG, Buffer.from('fetched')]);

/** The images directory of this test file. */
const IMAGES = mkdtempSync(join(tmpdir(), 'vision-pipeline-spec-'));
afterAll(() => rmSync(IMAGES, { recursive: true, force: true }));

/** A stand-in pipeline that records its calls. */
function fakePipeline() {
  return {
    process: vi.fn(async () => ({
      text: 'TOTAL $42.99',
      confidence: 0.93,
      category: 'printed-text',
      tiers: ['ocr'],
      tierResults: [],
      regions: [{}, {}],
      durationMs: 12,
    })),
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    dispose: vi.fn(async () => {}),
  };
}

/** The pack and its tool, with each strategy's pipeline made by `createVisionPipeline`. */
function setup(context = {}) {
  const made: Record<string, ReturnType<typeof fakePipeline>> = {};
  agentos.createVisionPipeline.mockImplementation(async ({ strategy }) => (made[strategy] = fakePipeline()));
  const pack = createExtensionPack(context);
  return { pack, tool: pack.descriptors[0].payload, made };
}

beforeEach(() => {
  agentos.imageToBuffer.mockResolvedValue(FETCHED);
});

afterEach(() => {
  agentos.createVisionPipeline.mockReset();
  agentos.imageToBuffer.mockReset();
  agentos.isPublicNetworkAddress = vi.fn(() => true);
});

describe('the pack', () => {
  it('registers the vision-pipeline tool and builds no pipeline until a call needs one', () => {
    const { pack } = setup();
    expect(pack.descriptors.map((descriptor) => descriptor.id)).toEqual(['vision-pipeline']);
    expect(pack.descriptors[0].payload.inputSchema.required).toEqual(['imageUrl']);
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });

  it('builds one pipeline per strategy, reuses it, and disposes of it on deactivation', async () => {
    const { pack, tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE });
    await tool.execute({ imageUrl: SOURCE, mode: 'ocr' });
    await tool.execute({ imageUrl: SOURCE, maxTier: 2 });

    expect(agentos.createVisionPipeline).toHaveBeenCalledTimes(2);
    // Without the embedding tier: a text call would otherwise run CLIP, wait
    // for it and drop the vector.
    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive', embedding: false });
    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'local-only', embedding: false });

    await pack.onDeactivate();
    expect(made.progressive.dispose).toHaveBeenCalled();
    expect(made['local-only'].dispose).toHaveBeenCalled();
  });

  it('reports a pipeline that fails to build, and builds again on the next call', async () => {
    const { tool } = setup();
    agentos.createVisionPipeline.mockRejectedValueOnce(new Error('ppu-paddle-ocr failed to load'));

    const failed = await tool.execute({ imageUrl: SOURCE });
    expect(failed).toEqual({ success: false, error: 'ppu-paddle-ocr failed to load' });

    const retried = await tool.execute({ imageUrl: SOURCE });
    expect(retried.success).toBe(true);
    expect(agentos.createVisionPipeline).toHaveBeenCalledTimes(2);
  });
});

describe('modes', () => {
  it('auto lets the pipeline decide, and returns its text and how it got it', async () => {
    const { tool, made } = setup();
    const result = await tool.execute({ imageUrl: SOURCE });

    expect(agentos.imageToBuffer).toHaveBeenCalledWith(SOURCE, { untrusted: true });
    expect(made.progressive.process).toHaveBeenCalledWith(FETCHED, undefined);
    expect(result).toEqual({
      success: true,
      output: { mode: 'auto', text: 'TOTAL $42.99', confidence: 0.93, category: 'printed-text', tiers: ['ocr'], regions: 2, durationMs: 12 },
    });
  });

  it.each([
    ['ocr', { tiers: ['ocr'] }],
    // Each names its tier: with the category alone, a confident OCR result
    // would return before TrOCR or Florence-2 had run.
    ['handwriting', { tiers: ['handwriting'], forceCategory: 'handwritten' }],
    ['layout', { tiers: ['document-ai'], forceCategory: 'document-layout' }],
    ['describe', { tiers: ['cloud-vision'] }],
  ])('%s runs the pipeline with %o', async (mode, options) => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, mode });
    expect(made.progressive.process).toHaveBeenCalledWith(FETCHED, options);
  });

  it('handwriting and layout name their tier on the local pipeline too', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, mode: 'handwriting', maxTier: 2 });
    await tool.execute({ imageUrl: SOURCE, mode: 'layout', maxTier: 2 });

    expect(made['local-only'].process).toHaveBeenNthCalledWith(1, FETCHED, { tiers: ['handwriting'], forceCategory: 'handwritten' });
    expect(made['local-only'].process).toHaveBeenNthCalledWith(2, FETCHED, { tiers: ['document-ai'], forceCategory: 'document-layout' });
  });

  it('embed returns the CLIP vector', async () => {
    const { tool, made } = setup();
    const result = await tool.execute({ imageUrl: SOURCE, mode: 'embed' });

    expect(made.progressive.embed).toHaveBeenCalledWith(FETCHED);
    expect(result.output).toEqual({ mode: 'embed', embedding: [0.1, 0.2, 0.3], dimensions: 3 });
  });

  it('refuses a mode it does not know', async () => {
    const { tool } = setup();
    const result = await tool.execute({ imageUrl: SOURCE, mode: 'toString' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('mode must be one of');
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });
});

describe('maxTier', () => {
  it('1 runs local OCR alone', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, maxTier: 1 });
    expect(made['local-only'].process).toHaveBeenCalledWith(FETCHED, { tiers: ['ocr'] });
  });

  it('reads a tier the model sent as a string', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, maxTier: '2' });
    await tool.execute({ imageUrl: SOURCE, maxTier: '3' });

    expect(made['local-only'].process).toHaveBeenCalledTimes(1);
    expect(made.progressive.process).toHaveBeenCalledTimes(1);
  });

  it.each([0, 4, 2.5, 'cloud', '', true, { tier: 3 }, null])('refuses maxTier %j, which the schema does not allow, instead of reading it as the highest', async (maxTier) => {
    // The highest tier sends the image to a cloud model.
    const { tool } = setup();
    const result = await tool.execute({ imageUrl: SOURCE, mode: 'describe', maxTier });

    expect(result).toEqual({ success: false, error: 'maxTier must be 1, 2 or 3.' });
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });

  it('refuses a mode that needs a higher tier, before building a pipeline', async () => {
    const { tool } = setup();
    const describe2 = await tool.execute({ imageUrl: SOURCE, mode: 'describe', maxTier: 2 });
    const handwriting1 = await tool.execute({ imageUrl: SOURCE, mode: 'handwriting', maxTier: 1 });

    expect(describe2.error).toBe('describe needs maxTier 3 or higher; this call allows 2.');
    expect(handwriting1.error).toBe('handwriting needs maxTier 2 or higher; this call allows 1.');
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });
});

describe('image sources', () => {
  it('decodes a data URL to its bytes', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: 'data:image/png;base64,aGVsbG8=', mode: 'ocr' });

    const [image] = made.progressive.process.mock.calls[0];
    expect(Buffer.isBuffer(image)).toBe(true);
    expect(image.toString('utf8')).toBe('hello');
  });

  it('reads no local file: a path is refused before any pipeline is built', async () => {
    const { tool } = setup();
    for (const imageUrl of ['/etc/hosts', 'file:///etc/hosts', 'scan.png', 'C:\\scans\\page.png']) {
      const result = await tool.execute({ imageUrl });
      expect(result.success).toBe(false);
      expect(result.error).toContain('other local files are not read');
    }
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });

  it('hands AgentOS one spelling of an http(s) URL, whatever the model wrote', async () => {
    const { tool } = setup();
    await tool.execute({ imageUrl: '  HTTPS://Example.com/scans/../receipt.png \n' });

    expect(agentos.imageToBuffer).toHaveBeenCalledWith('https://example.com/receipt.png', { untrusted: true });
  });
});

describe('a saved image as a source', () => {
  const user1 = { userContext: { userId: 'user-1' } };

  it('reads an image the image tools saved, for the caller it was saved for', async () => {
    // The image-generation and image-editing packs save with this function.
    const saved = await saveImageFile(PNG, IMAGES, scopeOf(user1));
    const { tool, made } = setup({ options: { imageDir: IMAGES } });

    const result = await tool.execute({ imageUrl: saved, mode: 'ocr' }, user1);

    expect(result.success).toBe(true);
    expect(made.progressive.process).toHaveBeenCalledWith(PNG, { tiers: ['ocr'] });
    // The file is read here: AgentOS is handed no path and fetches nothing.
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();

    for (const context of [{ userContext: { userId: 'user-2' } }, undefined]) {
      const other = await tool.execute({ imageUrl: saved, mode: 'ocr' }, context);
      expect(other.success).toBe(false);
      expect(other.error).toContain('other local files are not read');
    }
    expect(made.progressive.process).toHaveBeenCalledTimes(1);
  });

  it('is no image source to the exported imageInput, which reads no file', async () => {
    const saved = await saveImageFile(PNG, IMAGES, scopeOf(user1));

    expect(imageInput(saved)).toBeUndefined();
    expect(imageInput('file:///etc/hosts')).toBeUndefined();
    expect(imageInput(SOURCE)).toBe(SOURCE);
  });

  it('reads no other file: by another name, outside the directory, or no image', async () => {
    const saved = fileURLToPath(await saveImageFile(PNG, IMAGES, scopeOf(user1)));
    const scope = dirname(saved);
    const name = (hex: string) => `agentos-image-${hex.repeat(32)}.png`;
    const outside = mkdtempSync(join(tmpdir(), 'vision-pipeline-outside-'));
    writeFileSync(join(outside, name('a')), PNG);
    writeFileSync(join(scope, 'scan.png'), PNG);
    writeFileSync(join(scope, name('b')), 'root:x:0:0:root:/root:/bin/sh\n');
    const { tool } = setup({ options: { imageDir: IMAGES } });
    try {
      for (const imageUrl of [
        saved,
        pathToFileURL(join(outside, name('a'))).href,
        pathToFileURL(join(scope, 'scan.png')).href,
        pathToFileURL(join(scope, name('b'))).href,
        pathToFileURL(join(scope, name('c'))).href,
        `file://example.com${saved}`,
      ]) {
        const result = await tool.execute({ imageUrl, mode: 'ocr' }, user1);
        expect(result.success, imageUrl).toBe(false);
        expect(result.error, imageUrl).toContain('other local files are not read');
      }
      expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('with an AgentOS that has no untrusted fetch (before 0.13.16)', () => {
  beforeEach(() => {
    agentos.isPublicNetworkAddress = undefined;
  });

  it('refuses an http(s) image, which that AgentOS would fetch unchecked, and still reads a data URL', async () => {
    const { tool, made } = setup();

    const refused = await tool.execute({ imageUrl: SOURCE });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('needs @framers/agentos 0.13.16 or later');
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();

    expect((await tool.execute({ imageUrl: 'data:image/png;base64,aGVsbG8=', mode: 'ocr' })).success).toBe(true);
    expect(made.progressive.process.mock.calls[0][0].toString('utf8')).toBe('hello');
  });
});

describe('review follow-ups', () => {
  it('decodes a percent-encoded data URL byte by byte, and an invalid escape does not throw', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: 'data:image/svg+xml,%3Csvg%3E%ZZ%3C/svg%3E', mode: 'ocr' });
    await tool.execute({ imageUrl: 'data:image/png,%89PNG', mode: 'ocr' });

    const [svg] = made.progressive.process.mock.calls[0];
    const [png] = made.progressive.process.mock.calls[1];
    expect(svg.toString('utf8')).toBe('<svg>%ZZ</svg>');
    expect([...png]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('refuses this machine and private networks before building a pipeline', async () => {
    const { tool } = setup();
    for (const imageUrl of [
      'http://127.0.0.1/scan.png',
      'http://169.254.169.254/latest',
      'http://[::1]/scan.png',
      'http://0x7f000001/scan.png',
      'http://192.88.99.2/scan.png',
      'http://[2001::1]/scan.png',
      'http://[3fff::1]/scan.png',
      'http://[100:0:0:1::1]/scan.png',
      'http://[5f00::1]/scan.png',
      // Outside 2000::/3, the one block allocated for global unicast, and the
      // deprecated IPv4-compatible form.
      'http://[4000::1]/scan.png',
      'http://[fe00::1]/scan.png',
      'http://[::8.8.8.8]/scan.png',
    ]) {
      const result = await tool.execute({ imageUrl });
      expect(result.success, imageUrl).toBe(false);
      expect(result.error).toContain('private network');
    }
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });

  it('gives the cloud tier the OpenAI key from the secrets', async () => {
    const { tool } = setup({ getSecret: (id: string) => (id === 'openai.apiKey' ? 'sk-vision' : undefined) });
    await tool.execute({ imageUrl: SOURCE, mode: 'describe' });

    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive', embedding: false, cloudProvider: 'openai', cloudApiKey: 'sk-vision' });
  });

  it('reports a pipeline that fails to release on deactivation', async () => {
    const warn = vi.fn();
    const { pack, tool, made } = setup({ logger: { info: vi.fn(), warn } });
    await tool.execute({ imageUrl: SOURCE });
    made.progressive.dispose.mockRejectedValueOnce(new Error('worker would not stop'));

    await pack.onDeactivate();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('worker would not stop'));
  });

  it('decodes a long percent-encoded payload in one pass', async () => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: `data:image/svg+xml,${'%41'.repeat(100_000)}`, mode: 'ocr' });

    const [image] = made.progressive.process.mock.calls[0];
    expect(image.length).toBe(100_000);
    expect(image.every((byte: number) => byte === 0x41)).toBe(true);
  });

  it('builds no pipeline once deactivated, and builds again when activated', async () => {
    const { pack, tool } = setup();
    await pack.onDeactivate();

    const refused = await tool.execute({ imageUrl: SOURCE });
    expect(refused).toEqual({ success: false, error: 'The Vision & OCR Pipeline pack is deactivated.' });
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();

    await pack.onActivate();
    expect((await tool.execute({ imageUrl: SOURCE })).success).toBe(true);
  });

  it('skips a blank option key for the secret', async () => {
    const { tool } = setup({ options: { openaiApiKey: '  ' }, getSecret: (id: string) => (id === 'openai.apiKey' ? 'sk-secret' : undefined) });
    await tool.execute({ imageUrl: SOURCE });

    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive', embedding: false, cloudProvider: 'openai', cloudApiKey: 'sk-secret' });
  });
});

describe('data URLs, read as AgentOS reads them', () => {
  it.each([
    'data:image/png; base64,aGVsbG8=',
    'data:image/png;base64 ,aGVsbG8=',
    'data:image/png;\tbase64,aGVsbG8=',
    'data:image/png;base64\r\n,aGVsbG8=',
    'data:image/png;ba\nse64,aGVs\nbG8=',
  ])('decodes %j as base64: spaces around ;base64, and no tab or line break', async (imageUrl) => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl, mode: 'ocr' });

    expect(made.progressive.process.mock.calls[0][0].toString('utf8')).toBe('hello');
  });
});

describe('what the pipeline reports', () => {
  it('returns the layout and each failed tier with the text', async () => {
    const layout = {
      pages: [{
        pageNumber: 1,
        width: 640,
        height: 480,
        blocks: [{ type: 'text', content: 'Invoice 42', bbox: { x: 10, y: 20, width: 100, height: 20 }, confidence: 0.8 }],
      }],
    };
    const failedTiers = [{ tier: 'handwriting', error: 'Could not locate file: "tokenizer.json".' }];
    const { tool } = setup();
    const pipeline = fakePipeline();
    pipeline.process.mockResolvedValue({
      text: 'Invoice 42',
      confidence: 0.8,
      category: 'document-layout',
      tiers: ['ocr', 'document-ai'],
      tierResults: [],
      regions: [],
      layout,
      failedTiers,
      durationMs: 30,
    });
    agentos.createVisionPipeline.mockImplementation(async () => pipeline);

    expect(await tool.execute({ imageUrl: SOURCE, mode: 'layout' })).toEqual({
      success: true,
      output: {
        mode: 'layout',
        text: 'Invoice 42',
        confidence: 0.8,
        category: 'document-layout',
        tiers: ['ocr', 'document-ai'],
        regions: 0,
        layout,
        failedTiers,
        durationMs: 30,
      },
    });
  });
});

describe('with an AgentOS that fetches untrusted images', () => {
  const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  it('fetches an http(s) image with untrusted: true and hands the pipeline the bytes', async () => {
    agentos.isPublicNetworkAddress = vi.fn(() => true);
    agentos.imageToBuffer.mockResolvedValue(BYTES);
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, mode: 'ocr' });
    await tool.execute({ imageUrl: SOURCE, mode: 'embed' });

    expect(agentos.imageToBuffer).toHaveBeenCalledWith(SOURCE, { untrusted: true });
    expect(made.progressive.process).toHaveBeenCalledWith(BYTES, { tiers: ['ocr'] });
    expect(made.progressive.embed).toHaveBeenCalledWith(BYTES);
  });

  it('returns a refused URL as the tool error, before building a pipeline', async () => {
    const refused = 'imageToBuffer: example.com resolves to 169.254.169.254, which is not a public network address.';
    agentos.isPublicNetworkAddress = vi.fn(() => true);
    agentos.imageToBuffer.mockRejectedValue(Object.assign(new Error(refused), { code: 'IMAGE_URL_REFUSED' }));
    const { tool } = setup();

    expect(await tool.execute({ imageUrl: SOURCE })).toEqual({ success: false, error: refused });
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
  });

  it('decodes a data URL itself and fetches nothing', async () => {
    agentos.isPublicNetworkAddress = vi.fn(() => true);
    const { tool, made } = setup();
    await tool.execute({ imageUrl: 'data:image/png;base64,aGVsbG8=', mode: 'ocr' });

    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
    expect(made.progressive.process.mock.calls[0][0].toString('utf8')).toBe('hello');
  });
});
