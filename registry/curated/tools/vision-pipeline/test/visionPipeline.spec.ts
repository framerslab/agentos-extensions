// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool through the pack factory, with
 * AgentOS's createVisionPipeline mocked: no OCR engine, model or cloud
 * provider runs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// isPublicNetworkAddress is unset, as in an AgentOS without imageToBuffer's untrusted mode; tests that need it set it.
const agentos = vi.hoisted(() => ({ createVisionPipeline: vi.fn(), imageToBuffer: vi.fn(), isPublicNetworkAddress: undefined }));
vi.mock('@framers/agentos', () => agentos);

import { createExtensionPack } from '../src/index.js';

const SOURCE = 'https://example.com/receipt.png';

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

afterEach(() => {
  agentos.createVisionPipeline.mockReset();
  agentos.imageToBuffer.mockReset();
  agentos.isPublicNetworkAddress = undefined;
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
    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive' });
    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'local-only' });

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

    expect(made.progressive.process).toHaveBeenCalledWith(SOURCE, undefined);
    expect(result).toEqual({
      success: true,
      output: { mode: 'auto', text: 'TOTAL $42.99', confidence: 0.93, category: 'printed-text', tiers: ['ocr'], regions: 2, durationMs: 12 },
    });
  });

  it.each([
    ['ocr', { tiers: ['ocr'] }],
    ['handwriting', { forceCategory: 'handwritten' }],
    ['layout', { forceCategory: 'document-layout' }],
    ['describe', { tiers: ['cloud-vision'] }],
  ])('%s runs the pipeline with %o', async (mode, options) => {
    const { tool, made } = setup();
    await tool.execute({ imageUrl: SOURCE, mode });
    expect(made.progressive.process).toHaveBeenCalledWith(SOURCE, options);
  });

  it('embed returns the CLIP vector', async () => {
    const { tool, made } = setup();
    const result = await tool.execute({ imageUrl: SOURCE, mode: 'embed' });

    expect(made.progressive.embed).toHaveBeenCalledWith(SOURCE);
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
    expect(made['local-only'].process).toHaveBeenCalledWith(SOURCE, { tiers: ['ocr'] });
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
      expect(result.error).toContain('local file paths are not read');
    }
    expect(agentos.createVisionPipeline).not.toHaveBeenCalled();
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

    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive', cloudProvider: 'openai', cloudApiKey: 'sk-vision' });
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

    expect(agentos.createVisionPipeline).toHaveBeenCalledWith({ strategy: 'progressive', cloudProvider: 'openai', cloudApiKey: 'sk-secret' });
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
