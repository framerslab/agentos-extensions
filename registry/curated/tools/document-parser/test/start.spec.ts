import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadIsolated } from '@framers/agentos/cognition/memory';
import { startDocumentParser } from '../src/index.js';

// AgentOS's loader, as the reader imports it, with its own implementation until a case says otherwise: a case makes the
// server's one-page check fail the way a PDF reader that cannot read fails it.
vi.mock('@framers/agentos/cognition/memory', async (importOriginal) => {
  const real = await importOriginal<typeof import('@framers/agentos/cognition/memory')>();
  return { ...real, loadIsolated: vi.fn(real.loadIsolated) };
});

/** A fresh folder for one server's spool and socket. */
function folder() {
  const root = mkdtempSync(path.join(tmpdir(), 'parser-'));
  return { spool: path.join(root, 'spool'), socketPath: path.join(root, 'parser.sock') };
}

describe('the parser server whose PDF reader cannot read its one-page check', () => {
  it('refuses to start with the reader\'s own words, and makes neither the spool nor the socket', async () => {
    // What AgentOS's PDF reader throws on Node 22 under an unpdf before 1.6.1, whose pdf.js calls Promise.try.
    vi.mocked(loadIsolated).mockRejectedValueOnce(new TypeError('Promise.try is not a function'));
    const { spool, socketPath } = folder();
    await expect(startDocumentParser({ socketPath, spool })).rejects.toThrow(
      'startDocumentParser: the PDF reader could not read its one-page check: TypeError: Promise.try is not a function',
    );
    expect(existsSync(spool)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('refuses to start when the check reads without its page or its text', async () => {
    vi.mocked(loadIsolated).mockResolvedValueOnce(
      { content: '', metadata: { pageCount: 0 }, format: 'pdf' } as Awaited<ReturnType<typeof loadIsolated>>,
    );
    const { spool, socketPath } = folder();
    await expect(startDocumentParser({ socketPath, spool })).rejects.toThrow(
      'startDocumentParser: the PDF reader could not read its one-page check: it read without its page or its text',
    );
    expect(existsSync(spool)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  });
});
