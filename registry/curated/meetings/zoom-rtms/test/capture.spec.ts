import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const folders: string[] = [];

/** The settings the capture tool reads as it starts, each secret in a file of its own, the file `empty` names holding only whitespace. */
function settingsWith(empty: string): void {
  const folder = mkdtempSync(join(tmpdir(), 'zoom-capture-'));
  folders.push(folder);
  const file = (name: string, text: string): string => {
    const path = join(folder, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  vi.stubEnv('ZOOM_CLIENT_ID', 'client-id-1');
  vi.stubEnv('ZOOM_CLIENT_SECRET_FILE', file('client_secret', 'not-a-real-secret\n'));
  vi.stubEnv('ZOOM_WEBHOOK_SECRET_FILE', file('webhook_secret', 'not-a-real-secret\n'));
  vi.stubEnv('CAPTURE_OPERATOR_TOKEN_FILE', file('operator_token', 'not-a-real-token\n'));
  vi.stubEnv('CAPTURE_PUBLIC_URL', 'https://capture.test/zoom-capture');
  vi.stubEnv('CAPTURE_LISTEN', '127.0.0.1:0');
  vi.stubEnv('CAPTURE_OUT', join(folder, 'out'));
  vi.stubEnv(empty, file('empty', ' \n'));
}

describe('the capture tool, as it starts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  // An empty operator token would match a call that carries no token at all, and an empty webhook secret would accept a
  // signature anyone can make: the tool must stop before it listens.
  it.each(['ZOOM_CLIENT_SECRET_FILE', 'ZOOM_WEBHOOK_SECRET_FILE', 'CAPTURE_OPERATOR_TOKEN_FILE'])('refuses to start when the file %s names is empty', async (name) => {
    settingsWith(name);
    await expect(import('../src/capture/main.js')).rejects.toThrow(`the file ${name} names is empty`);
  });
});
