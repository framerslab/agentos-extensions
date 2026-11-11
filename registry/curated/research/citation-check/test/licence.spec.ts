import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readLicence } from '../src/index';

// The licence a page states: a link or an anchor marked rel="license", a JSON-LD `license`, or an anchor to a Creative
// Commons deed anywhere in the page, named from the deeds' table by its address.

const BASE = 'https://pages.example.test/articles/harbour';

function page(head: string, body: string): string {
  return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('readLicence', () => {
  it('reads a <link rel="license"> and names the deed by its address', () => {
    const html = page('<link rel="license" href="https://creativecommons.org/licenses/by-sa/4.0/">', '<p>Text.</p>');
    expect(readLicence(html, BASE)).toEqual({ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
  });

  it('reads an <a rel="license"> among other rel tokens, its address resolved against the page’s, with a ported deed’s place', () => {
    const html = page('', '<p>Reuse: <a class="lic" rel="noopener license" href="//creativecommons.org/licenses/by-nc-nd/3.0/us/">some rights reserved</a></p>');
    expect(readLicence(html, BASE)).toEqual({ name: 'CC BY-NC-ND 3.0 US', url: 'https://creativecommons.org/licenses/by-nc-nd/3.0/us/' });
  });

  it('names a rel="license" address outside the deeds by its anchor’s text, else by its title, else by the address', () => {
    expect(readLicence(page('', '<a rel=license href="/terms">Terms of <b>use</b></a>'), BASE)).toEqual({ name: 'Terms of use', url: 'https://pages.example.test/terms' });
    expect(readLicence(page('<link rel="license" title="Open Data Licence" href="https://data.example.test/licence">', ''), BASE)).toEqual({
      name: 'Open Data Licence',
      url: 'https://data.example.test/licence',
    });
    expect(readLicence(page('<link href="https://data.example.test/licence" rel="license">', ''), BASE)).toEqual({
      name: 'https://data.example.test/licence',
      url: 'https://data.example.test/licence',
    });
  });

  it('reads a JSON-LD `license` as an address or as an object with its own name, in a graph too', () => {
    const asAddress = page('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","license":"https://creativecommons.org/licenses/by/4.0/"}</script>', '');
    expect(readLicence(asAddress, BASE)).toEqual({ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
    const asObject = page(
      `<script type='application/ld+json'>{"@graph":[{"@type":"WebSite"},{"@type":"Dataset","license":{"@type":"CreativeWork","name":"Open Government Licence v3.0","url":"https://licences.example.test/ogl/3"}}]}</script>`,
      '',
    );
    expect(readLicence(asObject, BASE)).toEqual({ name: 'Open Government Licence v3.0', url: 'https://licences.example.test/ogl/3' });
  });

  it('reads an anchor to a Creative Commons deed in a footer, and the public domain tools', () => {
    const footer = page('', '<article><p>Text.</p></article><footer><p>Text is available under <a href="https://creativecommons.org/licenses/by/4.0/deed.en">CC BY 4.0</a>.</p></footer>');
    expect(readLicence(footer, BASE)).toEqual({ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/deed.en' });
    expect(readLicence(page('', '<a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>'), BASE)).toEqual({ name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' });
    expect(readLicence(page('', '<a href="https://creativecommons.org/publicdomain/mark/1.0/">PD</a>'), BASE)).toEqual({ name: 'Public Domain Mark 1.0', url: 'https://creativecommons.org/publicdomain/mark/1.0/' });
  });

  it('takes a rel="license" link before a JSON-LD licence and a deed anchor', () => {
    const html = page(
      '<script type="application/ld+json">{"license":"https://creativecommons.org/licenses/by-nd/4.0/"}</script>',
      '<a href="https://creativecommons.org/licenses/by/2.0/">old</a><a rel="license" href="https://creativecommons.org/licenses/by-sa/3.0/">cc</a>',
    );
    expect(readLicence(html, BASE)).toEqual({ name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' });
  });

  it('passes over JSON-LD inside a comment, keeps a block a script wraps in one, and reads past a script that holds a comment opener', () => {
    const commented = page('<!-- <script type="application/ld+json">{"license":"https://creativecommons.org/publicdomain/zero/1.0/"}</script> -->', '<p>Text.</p>');
    expect(readLicence(commented, BASE)).toBeNull();
    const wrapped = page('<script type="application/ld+json"><!-- {"license":"https://creativecommons.org/licenses/by-sa/4.0/"} --></script>', '<p>Text.</p>');
    expect(readLicence(wrapped, BASE)).toEqual({ name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' });
    const opener = page('<script>var marker = "<!--";</script><link rel="license" href="https://creativecommons.org/licenses/by/4.0/">', '<p>Text.</p>');
    expect(readLicence(opener, BASE)).toEqual({ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
  });

  it('reads every named character reference in a licence’s name', () => {
    const html = page('', '<a rel="license" href="/terms">Conditions d&rsquo;utilisation de Fran&ccedil;ois &amp; Cie</a>');
    expect(readLicence(html, BASE)).toEqual({ name: 'Conditions d’utilisation de François & Cie', url: 'https://pages.example.test/terms' });
  });

  it('reads a page of a hundred thousand unclosed tags at once, in the built package', () => {
    // A scan that searched to the end of the page for each unclosed tag would take time that grows with the square of
    // the page, past any test timeout, so the built package runs in a child process under a deadline.
    const dist = new URL('../dist/index.js', import.meta.url).href;
    const script = [
      `import { readLicence } from ${JSON.stringify(dist)};`,
      `const html = '<p>Text.</p>' + '<a x'.repeat(100000) + '<meta content="'.repeat(50000) + '<script type="application/ld+json">'.repeat(20000);`,
      `process.stdout.write(JSON.stringify(readLicence(html, ${JSON.stringify(BASE)})));`,
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000 });
    expect(run.signal).toBeNull();
    expect(JSON.parse(run.stdout)).toBeNull();
  });

  it('finds none in a page that states none, links Creative Commons’ home, marks another rel, or names no web address', () => {
    expect(readLicence(page('<title>Harbour</title>', '<p>All rights reserved.</p>'), BASE)).toBeNull();
    expect(readLicence(page('', '<a href="https://creativecommons.org/">Creative Commons</a>'), BASE)).toBeNull();
    expect(readLicence(page('', '<a rel="licensee" href="https://pages.example.test/about">About</a>'), BASE)).toBeNull();
    expect(readLicence(page('<link rel="license" href="javascript:void(0)">', ''), BASE)).toBeNull();
    expect(readLicence(page('<script type="application/ld+json">{ not json</script>', ''), BASE)).toBeNull();
  });
});
