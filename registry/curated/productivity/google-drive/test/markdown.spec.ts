import { describe, expect, it } from 'vitest';
import { withoutEmbeddedPictures } from '../src/index.js';

/** A picture's data address, short enough to read in a case. */
const DATA = 'data:image/png;base64,iVBORw0KGgo=';

describe('withoutEmbeddedPictures', () => {
  /**
   * Code is text, not pictures: a fenced or indented code block, a code span and an escaped `!` keep their Markdown as
   * written, and a definition inside a code block defines nothing, so an image whose label it repeats keeps its own
   * definition's address.
   */
  it('keeps code blocks, code spans and escaped images as written, and reads no definition inside code', () => {
    const markdown = [
      '# Examples',
      '',
      '```markdown',
      `![example](${DATA})`,
      `[logo]: <${DATA}>`,
      '```',
      '',
      '~~~',
      `![tilde](${DATA})`,
      '~~~',
      '',
      `Inline \`![span](${DATA})\` stays.`,
      '',
      `    ![indented](${DATA})`,
      '',
      `An escaped \\![literal](${DATA}) is a link.`,
      '',
      '![Company logo][logo]',
      '',
      '[logo]: https://example.com/logo.png',
      '',
    ].join('\n');
    expect(withoutEmbeddedPictures(markdown)).toBe(markdown);
  });

  /** A definition with a title is still a definition: it goes with its line, and the image that names it stands as its text. */
  it('takes out a picture definition that carries a title, and the image that names it', () => {
    const markdown = ['![Chart][img]', '', `[img]: <${DATA}> "caption"`, `[alt]: ${DATA} 'other'`, `[par]: <${DATA}> (third)`, '', '![Alt][alt] and ![][par]', ''].join('\n');
    expect(withoutEmbeddedPictures(markdown)).toBe(['Chart', '', '', 'Alt and ', ''].join('\n'));
  });

  /**
   * A label's first definition is the one its references use, as CommonMark reads them: an image whose first definition is
   * an address keeps it when a later definition of the same label is a picture, and the later one, which nothing uses,
   * goes with its line. A picture defined first stands as its text whatever follows.
   */
  it('reads a reference by its first definition, and takes out every picture definition', () => {
    const linkedFirst = ['![Company logo][logo]', '', '[logo]: https://example.com/logo.png', `[LOGO]: <${DATA}>`, ''].join('\n');
    expect(withoutEmbeddedPictures(linkedFirst)).toBe(['![Company logo][logo]', '', '[logo]: https://example.com/logo.png', ''].join('\n'));
    const pictureFirst = ['![Gauge][g]', '', `[g]: <${DATA}>`, '[G]: https://example.com/g.png', ''].join('\n');
    expect(withoutEmbeddedPictures(pictureFirst)).toBe(['Gauge', '', '[G]: https://example.com/g.png', ''].join('\n'));
  });

  /** An image inside a picture's text, a link in it and an image with an empty destination are read as CommonMark reads them. */
  it('keeps the text of a picture in place, with the images and links inside it', () => {
    const markdown = [`![A [linked](https://example.com) gauge ![dial](${DATA}) at dawn](${DATA})`, '', '![Empty]()', ''].join('\n');
    expect(withoutEmbeddedPictures(markdown)).toBe(['A [linked](https://example.com) gauge dial at dawn', '', '![Empty]()', ''].join('\n'));
  });

  /** A byte order mark and Windows line endings stay, and the offsets after them still fall on the pictures. */
  it('keeps a byte order mark and Windows line endings', () => {
    const markdown = `﻿# Notes\r\n\r\n![][image1]\r\n\r\nSee it.\r\n\r\n[image1]: <${DATA}>\r\n`;
    expect(withoutEmbeddedPictures(markdown)).toBe('﻿# Notes\r\n\r\n\r\n\r\nSee it.\r\n\r\n');
  });

  /**
   * Thirty thousand image openers with no closing bracket (60 KB) are read in linear time: each opener no longer scans the
   * rest of the line before it fails, which took seconds for this input.
   */
  it('reads a long run of unmatched image openers in linear time', () => {
    const openers = '!['.repeat(30_000);
    const started = performance.now();
    expect(withoutEmbeddedPictures(openers)).toBe(openers);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
