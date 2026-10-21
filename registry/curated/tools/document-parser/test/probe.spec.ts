import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocxLoader, PdfLoader, loadIsolated } from '@framers/agentos/cognition/memory';
import { scannedPdf, simpleDocx, twoPagePdf } from './fixtures.js';

/** What a load gave: its content and metadata, or its error's name, message and code. */
function outcome(load: Promise<{ content: string; metadata: unknown }>): Promise<string> {
  return load.then(
    (document) => `ok ${JSON.stringify(document.content)} ${JSON.stringify(document.metadata)}`,
    (error: unknown) => error instanceof Error
      ? `error ${error.name}: ${error.message} [${String((error as { code?: unknown }).code ?? '')}] ${String((error as { cause?: unknown }).cause ?? '')}`
      : `error ${String(error)}`,
  );
}

/** The version of a package installed beside the workspace's agentos. */
function besideAgentos(name: string): string {
  const agentos = realpathSync(path.join(process.cwd(), 'node_modules', '@framers', 'agentos'));
  const file = name === '@framers/agentos' ? path.join(agentos, 'package.json') : path.join(agentos, '..', '..', name, 'package.json');
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
  } catch (error) {
    return `unreadable: ${(error as Error).message}`;
  }
}

describe('probe', () => {
  it('shows what each reading path gives in CI', async () => {
    const results = {
      agentos: besideAgentos('@framers/agentos'),
      unpdf: besideAgentos('unpdf'),
      mammoth: besideAgentos('mammoth'),
      isolatedPdfBounded: await outcome(loadIsolated('pdf', twoPagePdf(), { maxHeapMb: 256, maxExternalMb: 256, maxInflatedBytes: 50_000_000, timeoutMs: 20_000 })),
      isolatedPdfPlain: await outcome(loadIsolated('pdf', twoPagePdf())),
      inThreadPdf: await outcome(new PdfLoader().load(twoPagePdf())),
      isolatedScanned: await outcome(loadIsolated('pdf', scannedPdf())),
      isolatedDocx: await outcome(loadIsolated('docx', simpleDocx())),
      inThreadDocx: await outcome(new DocxLoader().load(simpleDocx())),
      isolatedMarkdown: await outcome(loadIsolated('markdown', Buffer.from('# Title\n\nwords'))),
    };
    expect(results).toEqual({});
  }, 60_000);
});
