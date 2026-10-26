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
 * path. An address ends at a space, a quote, a bracket, a parenthesis or a backtick, and sentence
 * punctuation, a bold, italic or strike run (`*`, `~`) right after it is no part of it, so the
 * markdown marks around a cut link stay where they were; an underscore is kept, since the tokens
 * themselves hold it. Every other link stays as it was written, and a bare path or a bare host with
 * no `www.` and no scheme is text, which the renderer never links, and stays as written.
 */

/** An address in running text: `http://` or `https://` in any case, or `www.` with no scheme; it ends at a space, a quote, a bracket, a parenthesis or a backtick. */
const ADDRESS = /(?:https?:\/\/|(?<![\w.-])www\.)[^\s<>()[\]"'`]+/gi;

/** A markdown link's destination rooted at `/`: `](/path...`, ending at a space or the closing parenthesis. */
const RELATIVE_LINK = /\]\((\/[^\s)]*)/g;

/** A reference definition's destination rooted at `/`: `[label]: /path...` at a line's start. */
const RELATIVE_REFERENCE = /^(\[[^\]\n]+\]:[ \t]*)(\/\S*)/gm;

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
    url = new URL(bare ? `http://${address}` : address);
  } catch {
    return match;
  }
  const path = tokenPathOf(url.pathname, paths);
  if (path === null) return match;
  return `${bare ? url.host : url.origin}${path}${trailing}`;
}

/** A relative destination cut to the token path, or `destination` as it was. */
function cutRelative(destination: string, paths: readonly string[]): string {
  const { address, trailing } = split(destination);
  let url: URL;
  try {
    url = new URL(address, 'http://relative.invalid');
  } catch {
    return destination;
  }
  const path = tokenPathOf(url.pathname, paths);
  return path === null ? destination : `${path}${trailing}`;
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
  if (out.includes('](/')) out = out.replace(RELATIVE_LINK, (_match, destination: string) => `](${cutRelative(destination, paths)}`);
  if (/^\[[^\]\n]+\]:/m.test(out)) out = out.replace(RELATIVE_REFERENCE, (_match, label: string, destination: string) => `${label}${cutRelative(destination, paths)}`);
  return out;
}
