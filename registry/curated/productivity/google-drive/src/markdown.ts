/**
 * @fileoverview A Doc's Markdown as Google exports it, without the pictures the export embeds as data addresses.
 * @module agentos-ext-google-drive/markdown
 */

import { parse, postprocess, preprocess } from 'micromark';

/** One event of micromark's parse: a token entered or left, in the order of the Markdown. */
type ParseEvent = ReturnType<typeof postprocess>[number];

/** A token of micromark's parse, with its start and end offsets in the Markdown it read. */
type ParseToken = ParseEvent[1];

/** A picture's data address: a destination that starts `data:image/`. */
const DATA_IMAGE = /^data:image\//i;

/** A byte order mark, which micromark reads past and counts its offsets after. */
const BYTE_ORDER_MARK = '﻿';

/** An image or a link of the parse: where it stands, where its text stands, and its destination or reference label. */
interface Media {
  image: boolean;
  start: number;
  end: number;
  /** Where its text (the image's alternative text) stands between `![` and `]`; null until the parse reaches it. */
  text: { start: number; end: number } | null;
  /** Whether it has a resource, `(destination "title")`, rather than a reference. */
  resource: boolean;
  destination: string | null;
  /** The label of a full reference, `[label]`; null for a collapsed or shortcut reference, whose label is its text. */
  reference: string | null;
}

/** A reference definition of the parse: where it stands, its label, and whether its destination is a picture's data address. */
interface Definition {
  start: number;
  end: number;
  label: string;
  picture: boolean;
}

/** A label as CommonMark matches labels (micromark's `normalizeIdentifier`): runs of white space as one space, trimmed, case folded. */
function normalLabel(label: string): string {
  return label.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase();
}

/**
 * The span a picture definition goes with: its whole line or lines, with the line ending after it, when nothing but
 * white space stands before it on its first line; the definition alone when a container's marker does, such as a block
 * quote's `>`, which stays.
 */
function definitionSpan(source: string, definition: Definition): [number, number] {
  let start = definition.start;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start -= 1;
  if (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') return [definition.start, definition.end];
  let end = definition.end;
  if (source.startsWith('\r\n', end)) end += 2;
  else if (source[end] === '\n' || source[end] === '\r') end += 1;
  return [start, end];
}

/**
 * A Doc's Markdown without the pictures Google embeds in it as data addresses. Google's Markdown export writes each
 * picture of a Doc as a reference definition with a `data:image/` destination (`[image1]: <data:image/png;base64,...>`)
 * and the image where it stands as a reference to it (`![][image1]`), so a reader of the Markdown as text reads the
 * picture's base64. Each such definition goes with its line, and each image whose label's first definition is one, or
 * that carries a `data:image/` address itself, stands as its alternative text, none for an image without one; images and
 * links inside that text stay as they are read. The Markdown is read as CommonMark reads it, by micromark's parse, which
 * keeps its open brackets on a stack rather than scanning the rest of a line from each one, so code (a fenced or indented
 * block, a code span), an escaped `!`, a definition inside code, pictures linked by address, every other definition and
 * every other line stay as written.
 */
export function withoutEmbeddedPictures(markdown: string): string {
  const mark = markdown.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const source = markdown.slice(mark.length);
  const events = postprocess(parse().document().write(preprocess()(source, undefined, true)));
  const slice = (token: ParseToken): string => source.slice(token.start.offset, token.end.offset);

  const definitions: Definition[] = [];
  const images: Media[] = [];
  const open: Media[] = [];
  let definition: Definition | null = null;
  for (const [step, token] of events) {
    const media = open[open.length - 1];
    if (step === 'exit') {
      if (token.type === 'image' || token.type === 'link') {
        const closed = open.pop();
        if (closed?.image === true) images.push(closed);
      } else if (token.type === 'definition' && definition !== null) {
        definitions.push(definition);
        definition = null;
      }
      continue;
    }
    switch (token.type) {
      case 'image':
      case 'link':
        open.push({ image: token.type === 'image', start: token.start.offset, end: token.end.offset, text: null, resource: false, destination: null, reference: null });
        break;
      case 'labelText':
        if (media !== undefined && media.text === null) media.text = { start: token.start.offset, end: token.end.offset };
        break;
      case 'resource':
        if (media !== undefined) media.resource = true;
        break;
      case 'resourceDestinationString':
        if (media !== undefined && media.destination === null) media.destination = slice(token);
        break;
      case 'referenceString':
        if (media !== undefined && media.reference === null) media.reference = slice(token);
        break;
      case 'definition':
        definition = { start: token.start.offset, end: token.end.offset, label: '', picture: false };
        break;
      case 'definitionLabelString':
        if (definition !== null) definition.label = slice(token);
        break;
      case 'definitionDestinationString':
        if (definition !== null) definition.picture = DATA_IMAGE.test(slice(token));
        break;
      default:
        break;
    }
  }

  // A label's first definition is the one every reference to it uses.
  const firstIsPicture = new Map<string, boolean>();
  for (const { label, picture } of definitions) {
    const key = normalLabel(label);
    if (!firstIsPicture.has(key)) firstIsPicture.set(key, picture);
  }

  const cuts: Array<[number, number]> = [];
  for (const found of definitions) if (found.picture) cuts.push(definitionSpan(source, found));
  for (const image of images) {
    const text = image.text ?? { start: image.end, end: image.end };
    const picture = image.resource
      ? image.destination !== null && DATA_IMAGE.test(image.destination)
      : firstIsPicture.get(normalLabel(image.reference ?? source.slice(text.start, text.end))) === true;
    // The image's text stays where it stands, with whatever the parse found inside it; its `![` and its tail go.
    if (picture) cuts.push([image.start, text.start], [text.end, image.end]);
  }
  if (cuts.length === 0) return markdown;

  cuts.sort((a, b) => a[0] - b[0]);
  let kept = mark;
  let at = 0;
  for (const [start, end] of cuts) {
    if (start < at) continue;
    kept += source.slice(at, start);
    at = end;
  }
  return kept + source.slice(at);
}
