/**
 * @fileoverview The link cut (D19): before a subject or a body is stored, every link whose path
 * is one of the product's token paths (`tickets.tokenPaths`) is cut to that path, dropping the
 * query, the fragment and the rest of the path, so a pasted sign-in link holds no token:
 * `/sign-in?token=<t>` and `/sign-in/<t>` both become `/sign-in`. Three forms are links to the
 * renderer and are cut: an `http://` or `https://` address, in any case, cut to its origin and the
 * path (a cut address comes back with its scheme and host in lower case, as the URL parser gives
 * them); a `www.` address with no scheme (the renderer's autolink literals make it a link), cut to
 * its host and the path; and a relative markdown destination rooted at `/`, in a link
 * (`[words](/sign-in?token=<t>)`) or in a reference definition (`[words]: /sign-in/<t>`), cut to the
 * path. A destination is read as the renderer reads it, in every spelling: inside angle brackets,
 * after spaces or a line break, a reference definition's on the next line, with its backslash
 * escapes undone, its numeric character references decoded and its path's percent-encoding undone,
 * so `[x](</sign-in?token=<t>>)`, `[x](/sign\-in?token=<t>)`, `[x](/sign&#45;in?token=<t>)` and
 * `[x](/%73ign-in?token=<t>)` are cut as the plain spelling is. An address ends at a space, a
 * quote, a bracket, a parenthesis or a backtick, and sentence
 * punctuation, a bold, italic or strike run (`*`, `~`) right after it is no part of it, so the
 * markdown marks around a cut link stay where they were; an underscore is kept, since the tokens
 * themselves hold it. Every other link stays as it was written, and a bare path or a bare host with
 * no `www.` and no scheme is text, which the renderer never links, and stays as written.
 */

/** An address in running text: `http://` or `https://` in any case, or `www.` with no scheme; it ends at a space, a quote, a bracket, a parenthesis or a backtick. */
const ADDRESS = /(?:https?:\/\/|(?<![\w.-])www\.)[^\s<>()[\]"'`]+/gi;

/**
 * A markdown link's destination rooted at `/`: after `](` and any spaces (one line break allowed),
 * bare (ending at a space or the closing parenthesis) or inside angle brackets, where spaces may
 * appear.
 */
const RELATIVE_LINK = /(\]\(\s*)(?:<(\/[^<>\n]*)>|(\/[^\s)]*))/g;

/**
 * A reference definition's destination rooted at `/`: `[label]:` at a line's start, any spaces (one
 * line break allowed), then the destination, bare or inside angle brackets.
 */
const RELATIVE_REFERENCE = /^(\[[^\]\n]+\]:[ \t]*(?:\n[ \t]*)?)(?:<(\/[^<>\n]*)>|(\/\S*))/gm;

/** A markdown backslash escape of ASCII punctuation, undone before a destination is read. */
const ESCAPED = /\\([!-/:-@\[-`{-~])/g;

/** A numeric character reference, decoded before a destination is read. */
const NUMERIC_REFERENCE = /&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});/g;

/**
 * `destination` as the renderer reads it: its backslash escapes undone and its numeric character
 * references decoded, so a spelling of a token path is cut as the plain one is.
 */
function asRendered(destination: string): string {
  return destination.replace(ESCAPED, '$1').replace(NUMERIC_REFERENCE, (match, hex: string | undefined, decimal: string | undefined) => {
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
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

/** An address cut to its origin (its host, for a `www.` address with no scheme) and the token path, or `match` as it was. */
function cutAddress(match: string, paths: readonly string[]): string {
  const { address, trailing } = split(match);
  const bare = !/^https?:\/\//i.test(address);
  let url: URL;
  try {
    url = new URL(bare ? `http://${asRendered(address)}` : asRendered(address));
  } catch {
    return match;
  }
  const path = tokenPathOf(decodedPath(url.pathname), paths);
  if (path === null) return match;
  return `${bare ? url.host : url.origin}${path}${trailing}`;
}

/**
 * A relative destination cut to the token path, or `destination` as it was; `angled` for one inside
 * angle brackets, where the trailing marks belong to the destination.
 */
function cutRelative(destination: string, paths: readonly string[], angled: boolean): string {
  const { address, trailing } = angled ? { address: destination, trailing: '' } : split(destination);
  let url: URL;
  try {
    url = new URL(asRendered(address), 'http://relative.invalid');
  } catch {
    return destination;
  }
  const path = tokenPathOf(decodedPath(url.pathname), paths);
  return path === null ? destination : `${path}${trailing}`;
}

/** The replacement of a destination match: the lead-in, then the cut destination, in its angle brackets when it had them. */
function cutDestination(lead: string, angled: string | undefined, bare: string | undefined, paths: readonly string[]): string {
  return angled !== undefined ? `${lead}<${cutRelative(angled, paths, true)}>` : `${lead}${cutRelative(bare ?? '', paths, false)}`;
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
  if (/https?:\/\/|www\./i.test(out)) out = out.replace(ADDRESS, (match) => cutAddress(match, paths));
  if (/\]\(\s*<?\//.test(out)) out = out.replace(RELATIVE_LINK, (_match, lead: string, angled: string | undefined, bare: string | undefined) => cutDestination(lead, angled, bare, paths));
  if (/^\[[^\]\n]+\]:/m.test(out)) out = out.replace(RELATIVE_REFERENCE, (_match, label: string, angled: string | undefined, bare: string | undefined) => cutDestination(label, angled, bare, paths));
  return out;
}
