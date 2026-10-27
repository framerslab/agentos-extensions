/**
 * @fileoverview The link cut (D19): before a subject or a body is stored, every link whose path
 * is one of the product's token paths (`tickets.tokenPaths`) is cut to that path, dropping the
 * query, the fragment and the rest of the path, so a pasted sign-in link holds no token:
 * `/sign-in?token=<t>` and `/sign-in/<t>` both become `/sign-in`. Three forms are links to the
 * renderer and are cut: an `http://` or `https://` address, in any case, cut to its origin and the
 * path (a cut address comes back with its scheme and host in lower case, as the URL parser gives
 * them); a `www.` address with no scheme (the renderer's autolink literals make it a link), cut to
 * its host and the path; and a relative markdown destination rooted at `/`, in a link
 * (`[words](/sign-in?token=<t>)`) or in a reference definition (`[words]: /sign-in/<t>`, at the
 * line's start or inside a blockquote or a list item, `> [words]: /sign-in/<t>`), cut to the path. A
 * destination is read as the renderer reads it, in every spelling: inside angle brackets,
 * after spaces or a line break, a reference definition's on the next line, with its backslash
 * escapes undone, its character references decoded (the numeric ones, `&#47;`, and the named ones
 * of HTML's table, `&sol;`, read from `character-entities`, the table the renderer itself decodes
 * with) and its path's percent-encoding undone, so `[x](</sign-in?token=<t>>)`,
 * `[x](/sign\-in?token=<t>)`, `[x](/sign&#45;in?token=<t>)` and `[x](/%73ign-in?token=<t>)` are cut
 * as the plain spelling is, and so are a leading slash or a scheme letter written as a character
 * reference or an escape (`[x](&#47;sign-in?token=<t>)`, `[x](&sol;sign-in?token=<t>)`,
 * `[x](&#104;ttps://host/sign-in?token=<t>)`), since a destination is decoded whole before the cut
 * decides what it is. A tab or a line break a reference puts into a destination (`&Tab;`,
 * `&NewLine;`) is dropped as the URL parser drops it from a link, so the link it would make is the
 * one cut; a name the renderer does not know is text; a destination that is no token link keeps the
 * spelling it had. A reference definition is cut at any indentation: the renderer reads one indented
 * up to three spaces as a definition, and inside a list item four or more as the item's continuation
 * and a definition too, while a token inside an indented code sample is a credential just the same,
 * so the cut asks no question of the indentation. The line ending between a definition's label and
 * a destination on the next line is a line feed, a carriage return and line feed, or a carriage
 * return alone, as the renderer reads them, and no line ending fits inside an angled destination. A
 * definition's label is
 * read as the renderer reads it: an escaped bracket (`[a\]b]`) and a line ending inside it are part
 * of the label, so the definition is cut as a plain one is, while a label of white space alone is
 * none to the renderer and its line is text. An address ends at a space, a quote, a bracket, an
 * angle bracket or a backtick, or at a closing parenthesis that closes none it opened: parentheses
 * in balanced pairs are part of it, as the renderer's autolink literal reads them, and a bare
 * markdown destination is read the same way, its backslash-escaped parentheses part of it too, so
 * `[x](/sign-in?context=(web)&token=<t>)` and `https://host/sign-in?from=(a)&token=<t>` are read
 * whole and the cut never leaves `&token=<t>)` behind it. Sentence punctuation, a bold, italic
 * or strike run (`*`, `~`) right after an address is no part of it, so the markdown marks around a
 * cut link stay where they were; an underscore is kept, since the tokens themselves hold it. Every other link
 * stays as it was written, and a bare path or a bare host with no `www.` and no scheme is text,
 * which the renderer never links, and stays as written. A subject or a body is cleaned of its
 * control characters before its links are cut (`storableText`), in that order: a control character
 * inside a path would hide the path from the cut, and the cleaning at the store would then leave the
 * working link.
 */
import { characterEntities } from 'character-entities';
import { clean } from '../store/clean.js';

/** Where an address in running text starts: `http://` or `https://` in any case, or `www.` with no scheme and no word character, dot or dash before it. */
const ADDRESS_START = /https?:\/\/|(?<![\w.-])www\./gi;

/** What ends an address beside white space: a quote, a bracket, an angle bracket or a backtick, which the renderer's autolink literal never holds. */
const ADDRESS_STOP = /[\s<>[\]"'`]/;

/** A bare markdown destination ends at white space alone, beside the parenthesis that closes the link. */
const DESTINATION_STOP = /\s/;

/** The lead of a markdown link's destination: `](` and any spaces (one line break allowed). */
const LINK_LEAD = /\]\(\s*/g;

/** A destination inside angle brackets, where spaces may appear but no line ending, read at the position set before the match. */
const ANGLED_DESTINATION = /<([^<>\r\n]*)>/y;

/**
 * The end of the address or bare destination that starts at `from`, read as the renderer reads it:
 * it ends at a character of `stop` or at a closing parenthesis that closes none it opened, and holds
 * parentheses in balanced pairs, in a destination (`escapes`) backslash-escaped ones too, so
 * `/sign-in?context=(web)&token=<t>` is read whole and a cut never leaves its end, the token in it,
 * behind. A pair left open runs on to the stop, as the renderer reads it.
 */
function scanEnd(text: string, from: number, stop: RegExp, escapes: boolean): number {
  let depth = 0;
  let at = from;
  while (at < text.length) {
    const char = text[at]!;
    if (escapes && char === '\\' && at + 1 < text.length && !/\s/.test(text[at + 1]!)) {
      at += 2;
      continue;
    }
    if (stop.test(char)) break;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    at += 1;
  }
  return at;
}

/**
 * The container marks a line may open with before a reference definition, which the renderer reads
 * inside a blockquote (`>`) and inside a list item (`-`, `+`, `*`, or a number with `.` or `)`, each
 * followed by its space) at any depth and in any order; each mark may have spaces before it.
 */
const CONTAINERS = String.raw`(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*`;

/**
 * A reference definition's label with the colon after it, as the renderer reads a label: between
 * its brackets, characters that are no unescaped bracket, a backslash escape of any character among
 * them (`[a\]b]` is one label) and line endings too, ending at the first unescaped `]`. The renderer
 * also asks for one character inside that is no space, tab or line ending, which the cut checks when
 * it reads the match, so `[ ]:` stays text.
 */
const LABEL = String.raw`\[((?:\\[\s\S]|[^\[\]\\])+)\]:`;

/**
 * A reference definition's destination, whatever it holds: the label at a line's start, after any
 * container marks and any indentation (the renderer reads up to three spaces as a definition at the
 * top level and more inside a list item; the cut takes every indentation, as the file comment says),
 * any spaces (one line ending allowed, a line feed, a carriage return and line feed or a carriage
 * return alone, with the next line's blockquote marks), then the destination, bare or inside angle
 * brackets.
 */
const REFERENCE_DESTINATION = new RegExp(String.raw`^(${CONTAINERS}[ \t]*${LABEL}[ \t]*(?:(?:\r\n|\r|\n)(?:[ \t]*>)*[ \t]*)?)(?:<([^<>\r\n]*)>|(\S+))`, 'gm');

/** Whether `text` holds a line a reference definition could start, after any container marks and any indentation. */
const REFERENCE_LINE = new RegExp(String.raw`^${CONTAINERS}[ \t]*${LABEL}`, 'm');

/**
 * What the renderer undoes or decodes in a destination, read left to right so an escaped `&` or
 * `\` is text and never the start of a reference or an escape: a backslash escape of ASCII
 * punctuation; a numeric character reference, hexadecimal with up to six digits or decimal with up
 * to seven, as the renderer bounds them; or a named one, `&name;`, up to 31 letters and digits,
 * which the renderer decodes through HTML's table of named references and leaves as text when the
 * name is not in it.
 */
const RENDERED = /\\([!-/:-@\[-`{-~])|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});|&([A-Za-z0-9]{1,31});/g;

/**
 * The character a numeric reference `code` decodes to, as the renderer decodes it: the replacement
 * character for zero, a control character (a tab, a line feed, a form feed and a carriage return
 * decode), a surrogate, a noncharacter or a code past Unicode.
 */
function numericReference(code: number): string {
  const control = code < 9 || code === 11 || (code > 13 && code < 32) || (code > 126 && code < 160);
  const surrogate = code > 0xd7ff && code < 0xe000;
  const noncharacter = (code > 0xfdcf && code < 0xfdf0) || (code & 0xffff) === 0xffff || (code & 0xffff) === 0xfffe;
  return control || surrogate || noncharacter || code > 0x10ffff ? '�' : String.fromCodePoint(code);
}

/**
 * `destination` as the renderer reads it: its backslash escapes undone and its character
 * references, numeric and named, decoded, so a spelling of a token path is cut as the plain one is.
 */
function asRendered(destination: string): string {
  return destination.replace(RENDERED, (match: string, escaped: string | undefined, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (escaped !== undefined) return escaped;
    if (name !== undefined) return Object.hasOwn(characterEntities, name) ? characterEntities[name] : match;
    return numericReference(hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal));
  });
}

/** `pathname` with its percent-encoding undone where it decodes, so `/%73ign-in` is read as the server reads it, `/sign-in`. */
function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Sentence punctuation and the emphasis marks an address may be followed by, which are no part of it. */
const TRAILING = /[.,;:!?*~]+$/;

/** The token paths as compared: each without its trailing slashes; `/` alone and the empty path are left out. */
function normalizedPaths(tokenPaths: readonly string[]): string[] {
  const paths: string[] = [];
  for (const path of tokenPaths) {
    if (typeof path !== 'string') continue;
    const trimmed = path.replace(/\/+$/, '');
    if (trimmed.startsWith('/') && trimmed.length > 1) paths.push(trimmed);
  }
  return paths;
}

/** The token path `pathname` is or lies under, or null. */
function tokenPathOf(pathname: string, paths: readonly string[]): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const candidate of paths) {
    if (path === candidate || path.startsWith(`${candidate}/`)) return candidate;
  }
  return null;
}

/** `match` split into the address and the trailing marks that are no part of it. */
function split(match: string): { readonly address: string; readonly trailing: string } {
  const trailing = TRAILING.exec(match)?.[0] ?? '';
  return { address: trailing === '' ? match : match.slice(0, -trailing.length), trailing };
}

/**
 * The rendered address `rendered` cut to its origin (its host, for a `www.` address with no scheme)
 * and the token path, or null when its path is no token path or the URL parser refuses it.
 */
function cutAddress(rendered: string, paths: readonly string[]): string | null {
  const { address, trailing } = split(rendered);
  const bare = !/^https?:\/\//i.test(address);
  let url: URL;
  try {
    url = new URL(bare ? `http://${address}` : address);
  } catch {
    return null;
  }
  const path = tokenPathOf(decodedPath(url.pathname), paths);
  return path === null ? null : `${bare ? url.host : url.origin}${path}${trailing}`;
}

/**
 * The rendered relative destination `rendered` cut to the token path, or null when its path is no
 * token path; `angled` for one inside angle brackets, where the trailing marks belong to the
 * destination.
 */
function cutRelative(rendered: string, paths: readonly string[], angled: boolean): string | null {
  const { address, trailing } = angled ? { address: rendered, trailing: '' } : split(rendered);
  let url: URL;
  try {
    url = new URL(address, 'http://relative.invalid');
  } catch {
    return null;
  }
  const path = tokenPathOf(decodedPath(url.pathname), paths);
  return path === null ? null : `${path}${trailing}`;
}

/**
 * The replacement of a destination match: the lead-in, then the destination, cut when, decoded as
 * the renderer decodes it, it is a path rooted at `/` or an address to a token path, and as it was
 * written otherwise; in its angle brackets when it had them.
 */
function cutDestination(lead: string, angled: string | undefined, bare: string | undefined, paths: readonly string[]): string {
  const raw = angled !== undefined ? angled : (bare ?? '');
  const rendered = asRendered(raw);
  const cut = rendered.startsWith('/') ? cutRelative(rendered, paths, angled !== undefined) : /^(?:https?:\/\/|www\.)/i.test(rendered) ? cutAddress(rendered, paths) : null;
  const destination = cut ?? raw;
  return angled !== undefined ? `${lead}<${destination}>` : `${lead}${destination}`;
}

/** `text` with every address to a token path cut to its origin and the path (the first pass of `cutTokenLinks`). */
function cutAddresses(text: string, paths: readonly string[]): string {
  let out = '';
  let last = 0;
  ADDRESS_START.lastIndex = 0;
  for (let start = ADDRESS_START.exec(text); start !== null; start = ADDRESS_START.exec(text)) {
    const end = scanEnd(text, start.index + start[0].length, ADDRESS_STOP, false);
    const address = text.slice(start.index, end);
    out += text.slice(last, start.index) + (cutAddress(asRendered(address), paths) ?? address);
    last = end;
    ADDRESS_START.lastIndex = end;
  }
  return out + text.slice(last);
}

/** `text` with every markdown link's destination to a token path cut (the second pass of `cutTokenLinks`). */
function cutLinkDestinations(text: string, paths: readonly string[]): string {
  let out = '';
  let last = 0;
  LINK_LEAD.lastIndex = 0;
  for (let lead = LINK_LEAD.exec(text); lead !== null; lead = LINK_LEAD.exec(text)) {
    const start = lead.index + lead[0].length;
    ANGLED_DESTINATION.lastIndex = start;
    const angled = text[start] === '<' ? ANGLED_DESTINATION.exec(text) : null;
    const end = angled !== null ? start + angled[0].length : scanEnd(text, start, DESTINATION_STOP, true);
    if (end === start) continue;
    out += text.slice(last, lead.index) + cutDestination(lead[0], angled?.[1], angled === null ? text.slice(start, end) : undefined, paths);
    last = end;
    LINK_LEAD.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * `text` with every link to a token path cut to that path (an address to its origin and the path);
 * other links and the rest of the text are unchanged. An address the URL parser refuses is left as
 * it is.
 */
export function cutTokenLinks(text: string, tokenPaths: readonly string[]): string {
  const paths = normalizedPaths(tokenPaths);
  if (paths.length === 0) return text;
  let out = text;
  if (/https?:\/\/|www\./i.test(out)) out = cutAddresses(out, paths);
  if (out.includes('](')) out = cutLinkDestinations(out, paths);
  if (REFERENCE_LINE.test(out)) {
    out = out.replace(REFERENCE_DESTINATION, (match: string, lead: string, label: string, angled: string | undefined, bare: string | undefined) =>
      // A label of spaces, tabs and line endings alone is no label to the renderer, so its line is text.
      label.trim().length === 0 ? match : cutDestination(lead, angled, bare, paths),
    );
  }
  return out;
}

/**
 * `text` as a subject or a body is stored: its control characters gone first (D26), then its token
 * links cut (D19), in that order, so a control character inside a path never hides the path from the
 * cut, which the cleaning at the store would then turn into a working link. The store cleans again,
 * which changes nothing.
 */
export function storableText(text: string, tokenPaths: readonly string[]): string {
  return cutTokenLinks(clean(text), tokenPaths);
}
