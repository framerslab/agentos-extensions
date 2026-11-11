/**
 * The calendar entry bundled for a browser by a bundler, not read by a pattern: esbuild builds a page that imports
 * `@framers/agentos-ext-document-export/calendar` by the package's name, with `platform: 'browser'`, from the build CI
 * makes before the tests run. esbuild resolves the name through the package's exports map as a package's own files
 * may (Node's self-reference, https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name; esbuild
 * implements it, https://github.com/evanw/esbuild/blob/main/CHANGELOG-2022.md, issue 2312), and for the browser it
 * refuses to resolve a module built into Node, so a build that succeeds holds none. The bundle then runs in a fresh
 * JavaScript realm that has no `process`, `require`, `Buffer` or any other Node global, and writes what the module
 * writes under Node.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, type BuildFailure } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { googleCalendarAddress, icsEvent } from '../../src/calendar/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '../..');
const packageName = (JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as { name: string }).name;

/** Bundles `contents`, a page's module in the pack's folder, for a browser as one script that sets `page`. */
function bundle(contents: string) {
  return build({
    stdin: { contents, resolveDir: packRoot, sourcefile: 'page.js', loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'page',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
}

/** One event as both helpers take it, its times as strings, so the realm the bundle runs in reads them as written. */
const EVENT = {
  uid: 'item-7@example.com',
  title: 'Café review; Q3, final \\ draft',
  description: 'Line one\nLine two',
  details: 'Line one\nLine two',
  start: '2026-11-12T10:00:00-05:00',
  end: '2026-11-12T10:30:00-05:00',
  stamp: '2026-11-10T09:08:07Z',
};

describe('the calendar entry in a browser bundle', () => {
  it('bundles for the browser by the package name, from the build alone, with no Node built-in', async () => {
    const result = await bundle(`export { icsEvent, googleCalendarAddress } from '${packageName}/calendar';`);
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((input) => !/^(page\.js|<stdin>)$/.test(input) && !/(^|\/)dist\/calendar\/[a-z]+\.js$/.test(input)))
      .toEqual([]);
    expect(inputs).toEqual(expect.arrayContaining([
      expect.stringMatching(/dist\/calendar\/index\.js$/),
      expect.stringMatching(/dist\/calendar\/ics\.js$/),
      expect.stringMatching(/dist\/calendar\/google\.js$/),
    ]));
    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((entry) => entry.path));
    expect(imports.filter((path) => path.startsWith('node:') || !/(^|\/)dist\/calendar\/[a-z]+\.js$/.test(path))).toEqual([]);
    const code = result.outputFiles[0]!.text;
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/['"]node:/);
  }, 30_000);

  it('fails the same browser build for a module that imports a Node built-in, so a pass above means none', async () => {
    const failure = await bundle(`import { readFileSync } from 'node:fs'; export const read = readFileSync;`).then(
      () => null,
      (error: unknown) => error as BuildFailure,
    );
    expect(failure).not.toBeNull();
    expect(failure!.errors.map((error) => error.text).join('\n')).toContain('node:fs');
  }, 30_000);

  it('runs in a realm with no Node global and writes what Node writes', async () => {
    const result = await bundle(`export { icsEvent, googleCalendarAddress } from '${packageName}/calendar';`);
    const realm: Record<string, unknown> = {};
    const page = runInNewContext(`${result.outputFiles[0]!.text}\n;page`, realm) as {
      icsEvent: typeof icsEvent;
      googleCalendarAddress: typeof googleCalendarAddress;
    };
    expect(runInNewContext('[typeof process, typeof require, typeof Buffer, typeof module].join()', realm)).toBe(
      'undefined,undefined,undefined,undefined',
    );
    const ics = page.icsEvent(EVENT);
    expect(ics).toBe(icsEvent(EVENT));
    expect(ics).toContain('\r\nDTSTART:20261112T150000Z\r\nDTEND:20261112T153000Z\r\n');
    expect(ics).toContain('\r\nSUMMARY:Café review\\; Q3\\, final \\\\ draft\r\n');
    const address = page.googleCalendarAddress(EVENT);
    expect(address).toBe(googleCalendarAddress(EVENT));
    expect(new URL(address).searchParams.get('dates')).toBe('20261112T150000Z/20261112T153000Z');
    const allDay = { uid: 'd-1', title: 'Launch', start: '2026-12-31', allDay: true, stamp: EVENT.stamp };
    expect(page.icsEvent(allDay)).toContain('\r\nDTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n');
    expect(page.googleCalendarAddress(allDay)).toBe(googleCalendarAddress(allDay));
  }, 30_000);
});
