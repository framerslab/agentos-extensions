// @ts-nocheck
/**
 * @fileoverview The image-editing tools through the pack factory, with AgentOS's
 * image functions mocked: no provider is called. The files the tools save are
 * real, in a directory of the test's own.
 */

import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentos = vi.hoisted(() => ({
  editImage: vi.fn(),
  transferStyle: vi.fn(),
  upscaleImage: vi.fn(),
  variateImage: vi.fn(),
  imageToBuffer: vi.fn(),
  // Set, as in an AgentOS that has imageToBuffer's untrusted mode (0.13.16 and later).
  isPublicNetworkAddress: vi.fn(() => true),
}));

vi.mock('@framers/agentos', () => agentos);

import { createExtensionPack } from '../src/index.js';

const SOURCE = 'https://example.com/photo.png';
const WINDOWS = process.platform === 'win32';

/** A PNG, a JPEG and a WebP, as far as their first bytes go. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
/** What the mocked AgentOS gives for a fetched http(s) image. */
const FETCHED = Buffer.concat([PNG, Buffer.from('fetched')]);

/** The images directory of this test file. */
const IMAGES = mkdtempSync(join(tmpdir(), 'image-editing-spec-'));
afterAll(() => rmSync(IMAGES, { recursive: true, force: true }));

/** The pack's tools by name, made from these secrets and options. */
function tools(secrets: Record<string, string> = {}, options: Record<string, unknown> = {}) {
  const pack = createExtensionPack({ getSecret: (id: string) => secrets[id], options: { imageDir: IMAGES, ...options } });
  return Object.fromEntries(pack.descriptors.map((descriptor) => [descriptor.id, descriptor.payload]));
}

/** A call's context for a user, as AgentOS passes one. */
const as = (userId: string) => ({ gmiId: 'gmi', personaId: 'persona', userContext: { userId } });

/** An answer of AgentOS's editImage with these images. */
const edited = (...images: unknown[]) => ({ images, provider: 'openai', model: 'gpt-image-2.5-sunburst', usage: {} });

// The pack falls back to these environment variables; each test sets its keys itself.
const ENV_VARS = ['OPENAI_API_KEY', 'STABILITY_API_KEY', 'REPLICATE_API_TOKEN', 'AGENTOS_IMAGE_DIR'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  // imageToBuffer as AgentOS has it, as far as these tests go: a data URL is
  // decoded, an http(s) URL gives the fetched bytes.
  agentos.imageToBuffer.mockImplementation(async (source: string) =>
    /^data:/i.test(source) ? Buffer.from(source.slice(source.indexOf(',') + 1), 'base64') : FETCHED,
  );
});

afterEach(() => {
  for (const fn of Object.values(agentos)) fn?.mockReset?.();
  agentos.isPublicNetworkAddress = vi.fn(() => true);
  for (const name of ENV_VARS) {
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

  it('offers no outpaint mode, which no provider route runs', () => {
    const { editImage } = tools();
    expect(editImage.inputSchema.properties.mode.enum).toEqual(['img2img', 'inpaint', 'style-transfer']);
    expect(editImage.description).not.toMatch(/outpaint/i);
  });
});

describe('editImage', () => {
  it('edits the fetched bytes with the provider that has a key, and returns the provider URL as it is', async () => {
    agentos.editImage.mockResolvedValue({
      images: [{ url: 'https://cdn.example.com/out.png' }],
      provider: 'stability',
      model: 'sd3.5-medium',
      usage: { costUSD: 0.04 },
    });

    const result = await tools({ 'stability.apiKey': 'sk-stability' }).editImage.execute({
      imageUrl: SOURCE,
      prompt: 'make it a watercolor',
      strength: 1.7,
    });

    expect(agentos.imageToBuffer).toHaveBeenCalledWith(SOURCE, { untrusted: true });
    expect(agentos.editImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: FETCHED,
        prompt: 'make it a watercolor',
        mode: 'img2img',
        strength: 1,
        provider: 'stability',
        apiKey: 'sk-stability',
      }),
    );
    expect(result).toEqual({
      success: true,
      output: { images: ['https://cdn.example.com/out.png'], provider: 'stability', model: 'sd3.5-medium', costUSD: 0.04 },
    });
  });

  it('sends the mask for inpainting, and refuses inpainting without one', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });

    const missing = await editImage.execute({ imageUrl: SOURCE, prompt: 'remove the car', mode: 'inpaint' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('maskUrl');
    expect(agentos.editImage).not.toHaveBeenCalled();

    const mask = `data:image/png;base64,${PNG.toString('base64')}`;
    const done = await editImage.execute({ imageUrl: SOURCE, prompt: 'remove the car', mode: 'inpaint', maskUrl: mask });
    expect(done.success).toBe(true);
    expect(agentos.imageToBuffer).toHaveBeenCalledWith(mask, { untrusted: true });
    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inpaint', image: FETCHED, mask: PNG, provider: 'openai' }));
  });

  it('runs style transfer through transferStyle with the style image and the key of the provider it chose', async () => {
    agentos.transferStyle.mockResolvedValue({ images: [{ url: 'https://cdn.example.com/styled.png' }], provider: 'replicate', model: 'flux-redux', usage: {} });
    const { editImage } = tools({ 'replicate.apiToken': 'r8-secret' });

    const missing = await editImage.execute({ imageUrl: SOURCE, prompt: 'in this style', mode: 'style-transfer' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('styleImageUrl');

    const done = await editImage.execute({
      imageUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      prompt: 'in this style',
      mode: 'style-transfer',
      styleImageUrl: 'https://example.com/style.png',
    });
    expect(done.output.images).toEqual(['https://cdn.example.com/styled.png']);
    expect(agentos.transferStyle).toHaveBeenCalledWith(
      expect.objectContaining({ image: PNG, styleReference: FETCHED, prompt: 'in this style', provider: 'replicate', apiKey: 'r8-secret' }),
    );
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
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    await tools().editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'replicate', apiKey: 'r8-env' }));
  });
});

describe('image data a provider returns', () => {
  it('is saved to a file, and the output carries its file: URL, never the data', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(200_000, 7)]);
    agentos.editImage.mockResolvedValue(
      edited(
        { base64: big.toString('base64'), mimeType: 'image/png' },
        // The provider's label says PNG; the bytes are a JPEG and a WebP.
        { dataUrl: `data:image/png;base64,${JPEG.toString('base64')}` },
        { url: `data:image/png;base64,${WEBP.toString('base64')}` },
      ),
    );

    const result = await tools({ 'openai.apiKey': 'sk-openai' }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(result.success).toBe(true);
    const [png, jpg, webp] = result.output.images;
    expect(basename(fileURLToPath(png))).toMatch(/^agentos-image-[0-9a-f]{32}\.png$/);
    expect(basename(fileURLToPath(jpg))).toMatch(/^agentos-image-[0-9a-f]{32}\.jpg$/);
    expect(basename(fileURLToPath(webp))).toMatch(/^agentos-image-[0-9a-f]{32}\.webp$/);
    expect(readFileSync(fileURLToPath(png))).toEqual(big);
    expect(readFileSync(fileURLToPath(jpg))).toEqual(JPEG);
    expect(readFileSync(fileURLToPath(webp))).toEqual(WEBP);
    // 200 KB of image went to disk: what the model gets back is three short URLs.
    expect(JSON.stringify(result.output).length).toBeLessThan(1000);
    expect(JSON.stringify(result.output)).not.toContain('data:');
  });

  it('fails the call when the data is not a PNG, JPEG or WebP image, and saves nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'image-editing-none-'));
    try {
      agentos.editImage.mockResolvedValue(edited({ base64: Buffer.from('<html>an error page</html>').toString('base64') }));
      const result = await tools({ 'openai.apiKey': 'sk-openai' }, { imageDir: dir }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

      expect(result).toEqual({ success: false, error: 'The provider returned data that is not a PNG, JPEG or WebP image.' });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes to the host\'s saveImage when it gave one, and its URL is the output', async () => {
    const saved: unknown[] = [];
    const saveImage = vi.fn(async (image) => {
      saved.push(image);
      return 'https://cdn.host.example/images/1.png';
    });
    agentos.variateImage.mockResolvedValue(edited({ base64: PNG.toString('base64') }));
    const context = as('user-1');

    const result = await tools({ 'openai.apiKey': 'sk-openai' }, { saveImage }).variateImage.execute({ imageUrl: SOURCE }, context);

    expect(result.output.images).toEqual(['https://cdn.host.example/images/1.png']);
    expect(saved).toEqual([{ bytes: PNG, mimeType: 'image/png', tool: 'variateImage', context }]);
  });

  it.each([
    ['a data URL', `data:image/png;base64,${PNG.toString('base64')}`],
    ['a file: URL', 'file:///srv/images/1.png'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['an opaque id', 'image-1'],
    ['an empty string', ''],
    ['a URL of 3,000 characters', `https://cdn.host.example/${'a'.repeat(3000)}`],
    ['no string', { url: 'https://cdn.host.example/1.png' }],
  ])('fails the call when the host\'s saveImage returns %s', async (_what, reference) => {
    agentos.upscaleImage.mockResolvedValue({ image: { base64: PNG.toString('base64') }, provider: 'replicate', model: 'real-esrgan', usage: {} });
    const result = await tools({ 'replicate.apiToken': 'r8' }, { saveImage: () => reference }).upscaleImage.execute({ imageUrl: SOURCE });

    expect(result).toEqual({ success: false, error: "The host's saveImage must return an http(s) URL of at most 2,048 characters." });
  });

  it('names the directory and the option when the image cannot be saved', async () => {
    // A file where the images directory should be.
    const blocked = join(IMAGES, 'not-a-directory');
    writeFileSync(blocked, 'x');
    agentos.editImage.mockResolvedValue(edited({ base64: PNG.toString('base64') }));

    const result = await tools({ 'openai.apiKey': 'sk-openai' }, { imageDir: blocked }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`The image could not be saved under ${blocked}`);
    expect(result.error).toContain('imageDir');
  });

  it.skipIf(WINDOWS)('refuses a directory that other users can write', async () => {
    const open = mkdtempSync(join(tmpdir(), 'image-editing-open-'));
    try {
      execFileSync('chmod', ['777', open]);
      agentos.editImage.mockResolvedValue(edited({ base64: PNG.toString('base64') }));
      const result = await tools({ 'openai.apiKey': 'sk-openai' }, { imageDir: open }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('no one else can write');
      expect(readdirSync(open)).toEqual([]);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('takes the directory from AGENTOS_IMAGE_DIR when the option names none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'image-editing-env-'));
    try {
      process.env.AGENTOS_IMAGE_DIR = dir;
      agentos.editImage.mockResolvedValue(edited({ base64: PNG.toString('base64') }));
      const result = await tools({ 'openai.apiKey': 'sk-openai' }, { imageDir: undefined }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

      expect(dirname(dirname(fileURLToPath(result.output.images[0])))).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a saved image as a source', () => {
  /** Saves PNG through the tool for this user and returns its file: URL. */
  async function save(userId?: string): Promise<string> {
    agentos.editImage.mockResolvedValueOnce(edited({ base64: PNG.toString('base64') }));
    const result = await tools({ 'openai.apiKey': 'sk-openai' }).editImage.execute(
      { imageUrl: SOURCE, prompt: 'x' },
      userId ? as(userId) : undefined,
    );
    return result.output.images[0];
  }

  it('is read from its file and handed to AgentOS as bytes, by every tool and for every image input', async () => {
    const saved = await save('user-1');
    const { editImage, upscaleImage, variateImage } = tools({ 'openai.apiKey': 'sk-openai', 'replicate.apiToken': 'r8' });
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    agentos.transferStyle.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    agentos.upscaleImage.mockResolvedValue({ image: { url: 'https://cdn.example.com/big.png' }, provider: 'replicate', model: 'real-esrgan', usage: {} });
    agentos.variateImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/v.png' }));
    agentos.imageToBuffer.mockClear();

    await editImage.execute({ imageUrl: saved, prompt: 'x', mode: 'inpaint', maskUrl: saved }, as('user-1'));
    await editImage.execute({ imageUrl: saved, prompt: 'x', mode: 'style-transfer', styleImageUrl: saved }, as('user-1'));
    await upscaleImage.execute({ imageUrl: saved }, as('user-1'));
    await variateImage.execute({ imageUrl: saved }, as('user-1'));

    expect(agentos.editImage).toHaveBeenLastCalledWith(expect.objectContaining({ image: PNG, mask: PNG }));
    expect(agentos.transferStyle).toHaveBeenLastCalledWith(expect.objectContaining({ image: PNG, styleReference: PNG }));
    expect(agentos.upscaleImage).toHaveBeenLastCalledWith(expect.objectContaining({ image: PNG }));
    expect(agentos.variateImage).toHaveBeenLastCalledWith(expect.objectContaining({ image: PNG }));
    // The file is read here: AgentOS gets no path and fetches nothing.
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
  });

  it('belongs to the user it was saved for: another user, and a call with no user, are refused', async () => {
    const ofUser1 = await save('user-1');
    const ofNoUser = await save();
    expect(dirname(fileURLToPath(ofUser1))).not.toBe(dirname(fileURLToPath(ofNoUser)));
    expect(basename(dirname(fileURLToPath(ofUser1)))).toMatch(/^u-[0-9a-f]{32}$/);
    expect(basename(dirname(fileURLToPath(ofNoUser)))).toBe('shared');
    const { variateImage } = tools({ 'openai.apiKey': 'sk-openai' });
    agentos.variateImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/v.png' }));

    for (const [imageUrl, context] of [
      [ofUser1, as('user-2')],
      [ofUser1, undefined],
      [ofNoUser, as('user-1')],
    ]) {
      const result = await variateImage.execute({ imageUrl }, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('the file: URL of an image this tool saved');
    }
    expect(agentos.variateImage).not.toHaveBeenCalled();

    expect((await variateImage.execute({ imageUrl: ofUser1 }, as('user-1'))).success).toBe(true);
    expect((await variateImage.execute({ imageUrl: ofNoUser })).success).toBe(true);
  });

  it('is the only kind of local file the tools read', async () => {
    const saved = fileURLToPath(await save());
    const scope = dirname(saved);
    const name = (hex: string, ext = 'png') => `agentos-image-${hex.repeat(32)}.${ext}`;
    // A file of the right name outside the directory.
    const outside = mkdtempSync(join(tmpdir(), 'image-editing-outside-'));
    writeFileSync(join(outside, name('a')), PNG);
    // A file of the right name in a subdirectory of the scope.
    mkdirSync(join(scope, 'deeper'));
    writeFileSync(join(scope, 'deeper', name('b')), PNG);
    // A file in the scope under another name, and one of the right name that is no image.
    writeFileSync(join(scope, 'photo.png'), PNG);
    writeFileSync(join(scope, name('c')), 'root:x:0:0:root:/root:/bin/sh\n');
    // An empty file of the right name.
    writeFileSync(join(scope, name('d')), '');
    const refused = [
      '/etc/hosts',
      'file:///etc/hosts',
      '../secret.png',
      'C:\\keys\\photo.png',
      saved,
      pathToFileURL(join(outside, name('a'))).href,
      pathToFileURL(join(scope, 'deeper', name('b'))).href,
      pathToFileURL(join(scope, 'photo.png')).href,
      pathToFileURL(join(scope, name('c'))).href,
      pathToFileURL(join(scope, name('d'))).href,
      pathToFileURL(join(scope, name('e'))).href,
      `file://example.com${saved}`,
      `${pathToFileURL(saved).href}?x=1#y`.replace(basename(saved), 'photo.png'),
    ];
    if (!WINDOWS) {
      // A link of the right name to an image elsewhere: symbolic, then hard.
      symlinkSync(join(outside, name('a')), join(scope, name('f')));
      linkSync(join(outside, name('a')), join(scope, name('0')));
      // A FIFO of the right name: opening it would wait for a writer.
      execFileSync('mkfifo', [join(scope, name('1'))]);
      refused.push(
        pathToFileURL(join(scope, name('f'))).href,
        pathToFileURL(join(scope, name('0'))).href,
        pathToFileURL(join(scope, name('1'))).href,
      );
    }
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });
    try {
      for (const source of refused) {
        for (const args of [
          { imageUrl: source, prompt: 'x' },
          { imageUrl: SOURCE, prompt: 'x', mode: 'inpaint', maskUrl: source },
          { imageUrl: SOURCE, prompt: 'x', mode: 'style-transfer', styleImageUrl: source },
        ]) {
          const result = await editImage.execute(args);
          expect(result.success, `${source} as ${Object.keys(args).pop()}`).toBe(false);
          expect(result.error, source).toContain('other local files are not read');
        }
      }
      expect(agentos.editImage).toHaveBeenCalledTimes(1);
      expect(agentos.transferStyle).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('image sources', () => {
  it('refuses this machine and private networks, however the address is written', async () => {
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });
    for (const imageUrl of [
      'http://127.0.0.1/a.png',
      'http://localhost/a.png',
      'http://localhost./a.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/a.png',
      'http://172.20.0.1/a.png',
      'http://192.168.0.5/a.png',
      'http://100.64.0.1/a.png',
      'http://2130706433/a.png',
      'http://0x7f000001/a.png',
      'http://127.1/a.png',
      'http://[::1]/a.png',
      'http://[::ffff:127.0.0.1]/a.png',
      'http://[fd00::1]/a.png',
      'http://[fe80::1]/a.png',
      'http://198.18.0.1/a.png',
      'http://203.0.113.5/a.png',
      'http://224.0.0.1/a.png',
      'http://[::127.0.0.1]/a.png',
      'http://[64:ff9b::7f00:1]/a.png',
      'http://[2002:7f00:1::]/a.png',
      'http://[ff02::1]/a.png',
      'http://[2001:db8::1]/a.png',
      'http://192.88.99.2/a.png',
      'http://[2001:2::1]/a.png',
      'http://[100:0:0:1::1]/a.png',
      'http://[3fff::1]/a.png',
      'http://[5f00::1]/a.png',
      // Outside 2000::/3, the one block allocated for global unicast.
      'http://[4000::1]/a.png',
      'http://[1::1]/a.png',
      'http://[fe00::1]/a.png',
      // The deprecated IPv4-compatible form, whatever it carries.
      'http://[::8.8.8.8]/a.png',
    ]) {
      const result = await editImage.execute({ imageUrl, prompt: 'x' });
      expect(result.success, imageUrl).toBe(false);
      expect(result.error).toContain('private network');
    }
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
    expect(agentos.editImage).not.toHaveBeenCalled();
  });

  it('fetches a public IPv6 literal, and an IPv4 address an IPv6 form carries', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });
    for (const imageUrl of ['http://[2001:4860:4860::8888]/a.png', 'http://[::ffff:8.8.8.8]/a.png', 'http://[64:ff9b::808:808]/a.png']) {
      expect((await editImage.execute({ imageUrl, prompt: 'x' })).success, imageUrl).toBe(true);
    }
    expect(agentos.imageToBuffer).toHaveBeenCalledWith('http://[2001:4860:4860::8888]/a.png', { untrusted: true });
  });

  it('hands AgentOS one spelling of a source, whatever the model wrote', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    const { editImage } = tools({ 'openai.apiKey': 'sk-openai' });

    await editImage.execute({ imageUrl: '  HTTPS://Example.com/a/../photo.png \n', prompt: 'x' });
    await editImage.execute({ imageUrl: `DATA:image/png;base64,${PNG.toString('base64')}`, prompt: 'x' });

    // An AgentOS before 0.13.16 matched "http" and "data:" in lower case only,
    // and read anything else with a slash as a file path.
    expect(agentos.imageToBuffer.mock.calls.map(([source]) => source)).toEqual([
      'https://example.com/photo.png',
      `data:image/png;base64,${PNG.toString('base64')}`,
    ]);
  });

  it('returns a refused URL as the tool error, and calls no provider', async () => {
    const refused = 'imageToBuffer: example.com does not resolve to a public network address.';
    agentos.imageToBuffer.mockRejectedValue(Object.assign(new Error(refused), { code: 'IMAGE_URL_REFUSED' }));
    const result = await tools({ 'openai.apiKey': 'sk-openai' }).variateImage.execute({ imageUrl: SOURCE });

    expect(result).toEqual({ success: false, error: refused });
    expect(agentos.variateImage).not.toHaveBeenCalled();
  });
});

describe('with an AgentOS that has no untrusted fetch (before 0.13.16)', () => {
  beforeEach(() => {
    agentos.isPublicNetworkAddress = undefined;
  });

  it('refuses an http(s) image, which that AgentOS would fetch unchecked', async () => {
    const { editImage, upscaleImage, variateImage } = tools({ 'openai.apiKey': 'sk-openai', 'replicate.apiToken': 'r8' });
    for (const result of [
      await editImage.execute({ imageUrl: SOURCE, prompt: 'x' }),
      await editImage.execute({ imageUrl: `data:image/png;base64,${PNG.toString('base64')}`, prompt: 'x', mode: 'inpaint', maskUrl: SOURCE }),
      await upscaleImage.execute({ imageUrl: SOURCE }),
      await variateImage.execute({ imageUrl: SOURCE }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error).toContain('needs @framers/agentos 0.13.16 or later');
    }
    expect(agentos.imageToBuffer).toHaveBeenCalledTimes(1);
    for (const fn of [agentos.editImage, agentos.upscaleImage, agentos.variateImage]) expect(fn).not.toHaveBeenCalled();
  });

  it('still takes a data URL', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    const result = await tools({ 'openai.apiKey': 'sk-openai' }).editImage.execute({
      imageUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      prompt: 'x',
    });

    expect(result.success).toBe(true);
    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ image: PNG }));
  });
});

describe('arguments the schema does not allow', () => {
  it.each([
    ['editImage', { prompt: 'x', mode: 'bogus' }, 'mode must be one of img2img, inpaint, style-transfer.'],
    ['editImage', { prompt: 'x', mode: 'outpaint' }, 'outpaint is not available'],
    ['editImage', { prompt: 'x', mode: 3 }, 'mode must be one of'],
    ['editImage', { prompt: '   ' }, 'prompt is required.'],
    ['editImage', { prompt: 42 }, 'prompt is required.'],
    ['editImage', { prompt: 'x', strength: 'high' }, 'strength must be a number from 0 to 1.'],
    ['editImage', { prompt: 'x', model: { id: 'gpt-image-2.5-sunburst' } }, 'model must be a string.'],
    ['editImage', { prompt: 'x', size: 1024 }, 'size must be a string.'],
    ['editImage', { prompt: 'x', negativePrompt: ['blur'] }, 'negativePrompt must be a string.'],
    ['editImage', { prompt: 'x', provider: 'midjourney' }, 'provider must be one of openai, stability, replicate or auto.'],
    ['upscaleImage', { scale: 99 }, 'scale must be 2 or 4.'],
    ['upscaleImage', { scale: 'big' }, 'scale must be 2 or 4.'],
    ['upscaleImage', { provider: 'openai' }, 'provider must be one of replicate, stability or auto.'],
    ['variateImage', { count: 'many' }, 'count must be a number from 1 to 4.'],
    ['variateImage', { size: {} }, 'size must be a string.'],
  ])('%s %j fails before anything is fetched or called', async (tool, args, error) => {
    const result = await tools({ 'openai.apiKey': 'sk-openai', 'replicate.apiToken': 'r8' })[tool].execute({ imageUrl: SOURCE, ...args });

    expect(result.success).toBe(false);
    expect(result.error).toContain(error);
    for (const fn of Object.values(agentos)) expect(fn).not.toHaveBeenCalled();
  });

  it('reads a number the model sent as a string', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    agentos.upscaleImage.mockResolvedValue({ image: { url: 'https://cdn.example.com/big.png' }, provider: 'replicate', model: 'real-esrgan', usage: {} });
    agentos.variateImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/v.png' }));
    const { editImage, upscaleImage, variateImage } = tools({ 'openai.apiKey': 'sk-openai', 'replicate.apiToken': 'r8' });

    await editImage.execute({ imageUrl: SOURCE, prompt: 'x', strength: '0.5' });
    await upscaleImage.execute({ imageUrl: SOURCE, scale: '4' });
    await variateImage.execute({ imageUrl: SOURCE, count: '3' });
    await variateImage.execute({ imageUrl: SOURCE, count: 9 });

    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ strength: 0.5 }));
    expect(agentos.upscaleImage).toHaveBeenCalledWith(expect.objectContaining({ scale: 4 }));
    expect(agentos.variateImage).toHaveBeenNthCalledWith(1, expect.objectContaining({ n: 3 }));
    // At most four variations.
    expect(agentos.variateImage).toHaveBeenNthCalledWith(2, expect.objectContaining({ n: 4 }));
  });
});

describe('providers and keys', () => {
  it('refuses a model that names another provider, which AgentOS would send this provider\'s key to', async () => {
    const all = tools({ 'openai.apiKey': 'sk-openai', 'replicate.apiToken': 'r8' });
    for (const [tool, args] of [
      ['editImage', { prompt: 'x', provider: 'openai', model: 'replicate:black-forest-labs/flux-fill-pro' }],
      ['editImage', { prompt: 'x', model: 'Stability:sd3.5-medium' }],
      ['editImage', { prompt: 'x', mode: 'style-transfer', styleImageUrl: SOURCE, model: 'fal:fal-ai/flux/dev' }],
      ['upscaleImage', { provider: 'replicate', model: 'openai:gpt-image-2.5-sunburst' }],
      ['variateImage', { provider: 'openai', model: 'ollama:llava' }],
    ]) {
      const result = await all[tool].execute({ imageUrl: SOURCE, ...args });
      expect(result.success, JSON.stringify(args)).toBe(false);
      expect(result.error).toMatch(/^model names the provider "[a-z]+", but this call uses (openai|replicate)/);
    }
    for (const fn of Object.values(agentos)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes on a model with its own provider\'s prefix, a Replicate version, and any model when it holds no key', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    const version = `stability-ai/sdxl:${'7'.repeat(64)}`;

    await tools({ 'openai.apiKey': 'sk-openai' }).editImage.execute({ imageUrl: SOURCE, prompt: 'x', model: ' openai:gpt-image-2.5-sunburst ' });
    await tools({ 'replicate.apiToken': 'r8' }).editImage.execute({ imageUrl: SOURCE, prompt: 'x', model: version });
    // With no key held, AgentOS takes the provider and its key from the environment.
    await tools().editImage.execute({ imageUrl: SOURCE, prompt: 'x', model: 'replicate:owner/name' });

    expect(agentos.editImage.mock.calls.map(([options]) => [options.provider, options.model, options.apiKey])).toEqual([
      ['openai', 'openai:gpt-image-2.5-sunburst', 'sk-openai'],
      ['replicate', version, 'r8'],
      [undefined, 'replicate:owner/name', undefined],
    ]);
  });

  it('skips a blank option key for the secret', async () => {
    agentos.editImage.mockResolvedValue(edited({ url: 'https://cdn.example.com/out.png' }));
    await tools({ 'openai.apiKey': ' sk-secret ' }, { openaiApiKey: '   ' }).editImage.execute({ imageUrl: SOURCE, prompt: 'x' });

    expect(agentos.editImage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', apiKey: 'sk-secret' }));
  });
});

describe('upscaleImage', () => {
  const upscaled = (provider: string) => ({ image: { url: 'https://cdn.example.com/big.png' }, provider, model: 'an-upscaler', usage: {} });

  it('asks Replicate first, whose upscaler takes the factor: 2 unless the call says 4', async () => {
    agentos.upscaleImage.mockResolvedValue(upscaled('replicate'));
    const { upscaleImage } = tools({ 'stability.apiKey': 'sk-stability' }, { replicateApiToken: 'r8-token' });

    const twice = await upscaleImage.execute({ imageUrl: SOURCE });
    const four = await upscaleImage.execute({ imageUrl: SOURCE, scale: 4 });

    expect(agentos.upscaleImage).toHaveBeenNthCalledWith(1, expect.objectContaining({ image: FETCHED, scale: 2, provider: 'replicate', apiKey: 'r8-token' }));
    expect(agentos.upscaleImage).toHaveBeenNthCalledWith(2, expect.objectContaining({ scale: 4, provider: 'replicate' }));
    expect(twice.output).toEqual({ image: 'https://cdn.example.com/big.png', provider: 'replicate', model: 'an-upscaler', scale: 2, costUSD: undefined });
    expect(four.output.scale).toBe(4);
  });

  it('on Stability, whose upscaler has one factor, gives 4 and refuses a call that asks for 2', async () => {
    agentos.upscaleImage.mockResolvedValue(upscaled('stability'));
    const { upscaleImage } = tools({ 'stability.apiKey': 'sk-stability' });

    const refused = await upscaleImage.execute({ imageUrl: SOURCE, scale: 2 });
    expect(refused).toEqual({ success: false, error: "Stability's upscaler returns four times the input: pass scale 4, or use Replicate." });
    expect(agentos.imageToBuffer).not.toHaveBeenCalled();
    expect(agentos.upscaleImage).not.toHaveBeenCalled();

    const done = await upscaleImage.execute({ imageUrl: SOURCE });
    expect(agentos.upscaleImage).toHaveBeenCalledWith(expect.objectContaining({ scale: 4, provider: 'stability', apiKey: 'sk-stability' }));
    expect(done.output.scale).toBe(4);
  });

  it('reports 4 when AgentOS, given no provider, took Stability', async () => {
    agentos.upscaleImage.mockResolvedValue(upscaled('stability'));
    const done = await tools().upscaleImage.execute({ imageUrl: SOURCE });

    expect(agentos.upscaleImage).toHaveBeenCalledWith(expect.objectContaining({ scale: 2, provider: undefined }));
    expect(done.output.scale).toBe(4);
  });
});
