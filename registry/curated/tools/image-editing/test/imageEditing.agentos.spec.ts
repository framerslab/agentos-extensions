// @ts-nocheck
/**
 * @fileoverview The image-editing tools with the published AgentOS, not a
 * mock: an http(s) image goes through AgentOS's imageToBuffer in its
 * untrusted mode, which checks every address the host name resolves to.
 *
 * The host name is `ip6-localhost`, which Ubuntu's /etc/hosts maps to ::1:
 * the tools' own check reads the host as written and lets it through, so only
 * AgentOS's check stands between the call and this machine. In CI the name
 * must resolve, or this file would test nothing; elsewhere the tests skip.
 * The provider keys are placeholders: a call that got past the check would
 * fail at the provider with a different error.
 *
 * The second part runs an edit and an upscale through AgentOS's own image
 * functions and provider classes, with only `fetch` stubbed: the provider
 * answers with image data, which the tool saves, and the saved file is the
 * source of the next call.
 */

import { lookup } from 'node:dns/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createExtensionPack } from '../src/index.js';

const loopbackName = await lookup('ip6-localhost').then(
  (entry) => entry.address === '::1',
  () => false,
);
if (process.env.CI && !loopbackName) {
  throw new Error('ip6-localhost must resolve to ::1 in CI (Ubuntu /etc/hosts); without it these tests would test nothing.');
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The paths the test server was asked for. */
const received: string[] = [];
let server: http.Server;
let port: number;

beforeAll(async () => {
  if (!loopbackName) return;
  server = http.createServer((req, res) => {
    received.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe.runIf(loopbackName)('with the published AgentOS', () => {
  it('serves the image to a direct request, so a refusal below is the check and not a dead server', async () => {
    const response = await fetch(`http://[::1]:${port}/image.png`);

    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    received.length = 0;
  });

  it('refuses a host name that resolves to this machine in every tool, and the server sees nothing', async () => {
    const pack = createExtensionPack({
      getSecret: (id: string) => ({ 'openai.apiKey': 'sk-placeholder', 'stability.apiKey': 'sk-placeholder' })[id],
      options: {},
    });
    const tools = Object.fromEntries(pack.descriptors.map((descriptor) => [descriptor.id, descriptor.payload]));
    const imageUrl = `http://ip6-localhost:${port}/image.png`;

    for (const [name, args] of [
      ['editImage', { imageUrl, prompt: 'make it a watercolor' }],
      ['upscaleImage', { imageUrl }],
      ['variateImage', { imageUrl }],
    ]) {
      const result = await tools[name].execute(args);

      expect(result.success, name).toBe(false);
      expect(result.error, name).toMatch(/ip6-localhost .*public network address/);
    }
    expect(received).toEqual([]);
  });
});

describe('with the published AgentOS, a provider that answers with image data', () => {
  /** A PNG as far as its first bytes go, and then enough to be worth keeping out of a model's context. */
  const IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100_000, 3)]);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const dir = mkdtempSync(join(tmpdir(), 'image-editing-agentos-'));

  afterEach(() => vi.restoreAllMocks());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('saves the edit, returns its file: URL, and takes that URL as the source of an upscale', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const address = String(url);
      // OpenAI's GPT Image models answer with base64, never a URL.
      if (address.includes('api.openai.com')) return json({ created: 1, data: [{ b64_json: IMAGE.toString('base64') }] });
      if (address.includes('api.replicate.com')) {
        return json({ id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/upscaled.png'] });
      }
      return new Response('not found', { status: 404 });
    });
    const pack = createExtensionPack({
      getSecret: (id: string) => ({ 'openai.apiKey': 'sk-placeholder', 'replicate.apiToken': 'r8-placeholder' })[id],
      options: { imageDir: dir },
    });
    const tools = Object.fromEntries(pack.descriptors.map((descriptor) => [descriptor.id, descriptor.payload]));

    const edited = await tools.editImage.execute({
      imageUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      prompt: 'make it a watercolor',
    });

    expect(edited.error).toBeUndefined();
    const [saved] = edited.output.images;
    expect(saved).toMatch(/^file:\/\//);
    expect(readFileSync(fileURLToPath(saved))).toEqual(IMAGE);
    // 100 KB of image went to disk; what goes back to the model is one URL.
    expect(JSON.stringify(edited.output).length).toBeLessThan(1000);
    const edit = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/images/edits'));
    expect(edit[1].body.get('model')).toBe('gpt-image-2.5-sunburst');

    const upscaled = await tools.upscaleImage.execute({ imageUrl: saved, scale: 4 });

    expect(upscaled.error).toBeUndefined();
    expect(upscaled.output).toMatchObject({ image: 'https://replicate.delivery/upscaled.png', provider: 'replicate', scale: 4 });
    const upscale = fetchSpy.mock.calls.find(([url]) => String(url).includes('api.replicate.com'));
    expect(JSON.parse(String(upscale[1].body)).input.image).toContain(IMAGE.toString('base64'));
  });
});
