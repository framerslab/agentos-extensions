// @ts-nocheck
/**
 * @fileoverview The vision-pipeline tool with the published AgentOS, not a
 * mock: an http(s) image goes through AgentOS's imageToBuffer in its
 * untrusted mode, which checks every address the host name resolves to. The
 * pipeline is a stand-in, so no OCR engine or model runs.
 *
 * The host name is `ip6-localhost`, which Ubuntu's /etc/hosts maps to ::1:
 * the tool's own check reads the host as written and lets it through, so only
 * AgentOS's check stands between the call and this machine. In CI the name
 * must resolve, or this file would test nothing; elsewhere the tests skip.
 */

import { lookup } from 'node:dns/promises';
import * as http from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { VisionPipelineTool } from '../src/tools/visionPipeline.js';

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

  it('refuses a host name that resolves to this machine, and the server sees nothing', async () => {
    const pipeline = { process: vi.fn(), embed: vi.fn() };
    const tool = new VisionPipelineTool(async () => pipeline);

    for (const mode of ['ocr', 'embed']) {
      const result = await tool.execute({ imageUrl: `http://ip6-localhost:${port}/image.png`, mode });

      expect(result.success, mode).toBe(false);
      expect(result.error, mode).toMatch(/ip6-localhost .*public network address/);
    }
    expect(received).toEqual([]);
    expect(pipeline.process).not.toHaveBeenCalled();
    expect(pipeline.embed).not.toHaveBeenCalled();
  });
});
