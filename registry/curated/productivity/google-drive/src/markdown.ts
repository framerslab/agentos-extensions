/**
 * @fileoverview A Doc's Markdown as Google exports it, without the pictures the export embeds as data addresses.
 * @module agentos-ext-google-drive/markdown
 */

/** A link label's text, as CommonMark reads it: anything but an unescaped bracket or a line break, up to 999 characters. */
const LABEL = String.raw`(?:[^\]\\\n]|\\.)`;

/** A picture's data address, bare or in angle brackets, as Google's export writes one. */
const DATA_ADDRESS = String.raw`(?:<data:image\/[^>\n]*>|data:image\/[^\s)]*)`;

/**
 * A reference definition whose destination is a picture's data address, with its line ending:
 * `[image1]: <data:image/png;base64,...>`, the form Google's export writes for every picture of a Doc.
 */
const PICTURE_DEFINITION = new RegExp(String.raw`^ {0,3}\[(${LABEL}{1,999})\]:[ \t]*${DATA_ADDRESS}[ \t]*(?:\r?\n|$)`, 'gm');

/** An inline image whose destination is a picture's data address, with an optional title: `![alt](data:image/...)`. */
const INLINE_PICTURE = new RegExp(String.raw`!\[(${LABEL}*)\]\([ \t]*${DATA_ADDRESS}(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*\)`, 'g');

/** A full or collapsed reference image: `![alt][label]` or `![label][]`. */
const REFERENCE_IMAGE = new RegExp(String.raw`!\[(${LABEL}*)\]\[(${LABEL}*)\]`, 'g');

/** A shortcut reference image, `![label]`, followed by neither a destination nor a label. */
const SHORTCUT_IMAGE = new RegExp(String.raw`!\[(${LABEL}*)\](?![[(])`, 'g');

/** A label as CommonMark matches labels: trimmed, its runs of white space as one space, case folded. */
function normalLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A Doc's Markdown without the pictures Google embeds in it as data addresses. Google's Markdown export writes each
 * picture of a Doc as a reference definition with a `data:image/` destination (`[image1]: <data:image/png;base64,...>`)
 * and the image where it stands as a reference to it (`![][image1]`), so a reader of the Markdown as text reads the
 * picture's base64. Each such definition goes with its line, and each image that names one, or carries a `data:image/`
 * address itself, stands as its alternative text, none for an image without one. Pictures linked by address, every other
 * definition and every other line stay as written.
 */
export function withoutEmbeddedPictures(markdown: string): string {
  const pictures = new Set<string>();
  let kept = markdown.replace(PICTURE_DEFINITION, (_definition, label: string) => {
    pictures.add(normalLabel(label));
    return '';
  });
  kept = kept.replace(INLINE_PICTURE, (_image, alt: string) => alt);
  if (pictures.size === 0) return kept;
  kept = kept.replace(REFERENCE_IMAGE, (image, alt: string, label: string) => (pictures.has(normalLabel(label === '' ? alt : label)) ? alt : image));
  return kept.replace(SHORTCUT_IMAGE, (image, alt: string) => (pictures.has(normalLabel(alt)) ? alt : image));
}
