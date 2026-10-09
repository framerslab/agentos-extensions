import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from '../src/html';

const LEAD = readFileSync(path.join(__dirname, 'fixtures/treaty-of-versailles-lead.html'), 'utf8');

describe('htmlToBlocks', () => {
  it("removes Wikipedia's reference markers and keeps the lead's sentences whole", () => {
    const blocks = htmlToBlocks(LEAD);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatch(/^The Treaty of Versailles was a peace treaty signed on 28 June 1919\. As the most important treaty of World War I,/);
    expect(blocks[0]).toContain('The other Central Powers on the German side signed separate treaties. Although the armistice of 11 November 1918 ended');
    expect(blocks[0]).toMatch(/Germany was not allowed to participate in the negotiations before signing the treaty\.$/);
    expect(blocks.join(' ')).not.toMatch(/\[(ii|iii|4)\]|langx|cite_note/);
  });

  it('drops the furniture with everything inside it, and ends a block at each block element and br', () => {
    const html = [
      '<div class="hatnote navigation-not-searchable">For the 1768 treaty, see X.</div>',
      '<div class="shortdescription">Peace treaty</div>',
      '<table class="infobox"><tr><td>Signed 28 June 1919</td></tr></table>',
      '<style>.x{color:red}</style><script>var y = "1918";</script><noscript>z</noscript>',
      '<p>First <i>one</i>.<br>Second one.</p>',
      '<figure><img src="a.jpg"><figcaption>A map, 1920.</figcaption></figure>',
      '<blockquote><p>Someone else said 1917.</p></blockquote>',
      '<pre>code 1</pre><math>x=2</math><span class="mwe-math-element">y</span>',
      '<div class="reflist"><ol class="references"><li>Davis 2010.</li></ol></div>',
      '<div class="mw-references-wrap">w</div><div class="navbox">n</div><div role="note">m</div>',
      '<ul><li>Item &amp; one</li><li>Item two</li></ul>',
      '<h2>Background</h2><section><p>Café</p></section>',
    ].join('');
    expect(htmlToBlocks(html)).toEqual(['First one.', 'Second one.', 'Item & one', 'Item two', 'Background', 'Café']);
  });

  it('drops maintenance tags and edit links inside a block, so its sentences read whole', () => {
    const html = '<h2>Terms<span class="mw-editsection">[edit]</span></h2><p>Signed in 1919.<sup class="noprint Inline-Template Template-Fact">[<i>citation needed</i>]</sup> Ratified in 1920.</p>';
    expect(htmlToBlocks(html)).toEqual(['Terms', 'Signed in 1919. Ratified in 1920.']);
  });

  it('keeps a void element inside a dropped element from ending the drop', () => {
    expect(htmlToBlocks('<table><tr><td><br><img src="x"> 1918</td></tr></table><p>After.</p>')).toEqual(['After.']);
  });

  it('puts each block in NFC and collapses white space, and stops at the budget of kept characters', () => {
    expect(htmlToBlocks('<p>Café\n\t  bar</p>')).toEqual(['Café bar']);
    const long = `<p>${'a '.repeat(400)}</p><p>later</p>`;
    const blocks = htmlToBlocks(long, { budget: 100 });
    expect(blocks.join(' ').length).toBeLessThanOrEqual(100);
    expect(blocks).not.toContain('later');
  });
});
