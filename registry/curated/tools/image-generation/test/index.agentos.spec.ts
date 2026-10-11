// @ts-nocheck
/**
 * @fileoverview generate_image through the published AgentOS, not a mock: its
 * own `generateImage` and OpenAI provider run, and only `fetch` is stubbed.
 * The request is the one OpenAI gets, and the answer is the one its GPT Image
 * models give: image data, never a URL.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import createExtensionPack from '../src/index.js';

/** A PNG as far as its first bytes go, and then enough to be worth keeping out of a model's context. */
const IMAGE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100_000, 3)]);
const dir = mkdtempSync(join(tmpdir(), 'image-generation-agentos-'));

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('generate_image with the published AgentOS', () => {
  it('asks OpenAI for GPT Image 2.5 Flare as that model takes its settings, and saves the image it answers with', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ created: 1, data: [{ b64_json: IMAGE.toString('base64') }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const pack = createExtensionPack({ options: { openaiApiKey: 'sk-placeholder', imageDir: dir } });

    const result = await pack.descriptors[0].payload.execute({ prompt: 'A lighthouse at dusk.', quality: 'hd', style: 'vivid' });

    expect(result.error).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(String(init.body));
    // `hd` and `style` were DALL·E 3's, which OpenAI shut down on 2026-05-12.
    expect(body).toMatchObject({ model: 'gpt-image-2.5-flare', quality: 'high', size: '1024x1024' });
    expect(body.prompt).toBe('A lighthouse at dusk.\n\nStyle: vivid, hyper-real and dramatic.');
    expect(body).not.toHaveProperty('style');
    // 100 KB of image went to disk; what goes back to the model is its URL.
    expect(result.output.url).toMatch(/^file:\/\//);
    expect(readFileSync(fileURLToPath(result.output.url))).toEqual(IMAGE);
    expect(JSON.stringify(result.output).length).toBeLessThan(1000);
  });
});

describe('generate_image with the published AgentOS, a provider that answers with a URL', () => {
  it("reads the provider's URL through AgentOS's untrusted read, and returns it with the reason when that read refuses it", async () => {
    // Replicate's API, answering in sync mode with a URL. This one is on this
    // machine, as a provider or a proxy in its place could answer: AgentOS's
    // read refuses the address before any connection is made.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('api.replicate.com')
        ? new Response(JSON.stringify({ id: 'p1', status: 'succeeded', output: ['http://127.0.0.1/out-0.png'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('not found', { status: 404 }),
    );
    const pack = createExtensionPack({ options: { replicateApiToken: 'r8-placeholder', imageDir: dir } });

    const result = await pack.descriptors[0].payload.execute({ prompt: 'A lighthouse at dusk.', provider: 'replicate' });

    expect(result.error).toBeUndefined();
    expect(result.output.url).toBe('http://127.0.0.1/out-0.png');
    expect(result.output.notes).toHaveLength(1);
    expect(result.output.notes[0]).toMatch(/could not be copied \(.*public network address/);
  });
});
