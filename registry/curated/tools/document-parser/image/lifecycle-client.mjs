/**
 * The lifecycle test's client (image/docker-compose.test.yml). It runs in a second container from the parser's own
 * image, as the parser's user, with the spool's volume at /run/parser and the pack's folder read-only at /lifecycle.
 * For each case it writes the file into the spool under a random name, asks the parser to read it through the image's
 * own client, and checks the answer and that the file is gone. It prints one line a case, then
 * `lifecycle: all <n> cases held` and exits 0, or names the cases that failed and exits 1.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { documentParserClient } from '/app/dist/client.js';
import { inflatingDocx, scannedPdf, simpleDocx, twoPagePdf } from '/lifecycle/test/fixtures.ts';

const SPOOL = '/run/parser/spool';
const parser = documentParserClient('/run/parser/parser.sock');

/** Each kind read, then each refusal the reader and the protocol make, as the parser in its container answers them. */
const cases = [
  { name: 'a text file', kind: 'text', bytes: Buffer.from('hello from the lifecycle test'), want: { ok: true, text: 'hello from the lifecycle test', pages: null } },
  { name: 'a Markdown file', kind: 'markdown', bytes: Buffer.from('# Lifecycle\n\nhello in Markdown'), want: { ok: true, text: 'hello in Markdown', pages: null } },
  { name: 'a PDF', kind: 'pdf', bytes: twoPagePdf(), want: { ok: true, text: 'Second page', pages: 2 } },
  { name: 'a Word file', kind: 'docx', bytes: simpleDocx(), want: { ok: true, text: 'Memo', pages: null } },
  { name: 'a scanned PDF', kind: 'pdf', bytes: scannedPdf(), want: { ok: false, failed: 'scanned' } },
  { name: 'a PDF past its page bound', kind: 'pdf', bytes: twoPagePdf(), bounds: { maxPages: 1 }, want: { ok: false, failed: 'too_long' } },
  // 50,000,001 zeros deflate to a few kilobytes: the file is small and its archive inflates past the loader's bound.
  { name: "a Word file that inflates past the loader's bound", kind: 'docx', bytes: inflatingDocx(50_000_001), want: { ok: false, failed: 'too_large' } },
  { name: 'a read past its deadline', kind: 'pdf', bytes: twoPagePdf(), bounds: { timeoutMs: 1 }, want: { ok: false, failed: 'timeout' } },
  { name: 'a path outside the spool', kind: 'text', path: '/etc/hostname', want: { ok: false, failed: 'outside_spool' } },
];

/** What is wrong with an answer, or null when it is the one the case wants and its file is gone. */
function problem(want, answer, file) {
  if (answer.ok !== want.ok) return `answered ${answer.ok ? 'with text' : `failed as ${answer.failed}`}`;
  if (answer.ok) {
    if (!answer.text.includes(want.text)) return `its text lacks "${want.text}"`;
    if (answer.pages !== want.pages) return `its page count is ${answer.pages}, not ${want.pages}`;
  } else if (answer.failed !== want.failed) {
    return `failed as ${answer.failed}, not ${want.failed}`;
  }
  if (file !== null && existsSync(file)) return 'its file is still in the spool';
  return null;
}

const failed = [];
for (const c of cases) {
  let file = null;
  let why;
  try {
    if (c.bytes) {
      file = `${SPOOL}/${randomUUID()}`;
      writeFileSync(file, c.bytes, { mode: 0o600 });
    }
    why = problem(c.want, await parser.parse(file ?? c.path, c.kind, c.bounds ?? {}), file);
  } catch (error) {
    why = `the call failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (why === null) console.log(`ok: ${c.name}`);
  else {
    failed.push(c.name);
    console.log(`not ok: ${c.name}: ${why}`);
  }
}

if (failed.length === 0) console.log(`lifecycle: all ${cases.length} cases held`);
else console.log(`lifecycle: ${failed.length} of ${cases.length} cases failed: ${failed.join('; ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
