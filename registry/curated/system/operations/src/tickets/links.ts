/**
 * @fileoverview The link cut (D19): before a subject or a body is stored, every link whose path
 * is one of the product's token paths (`tickets.tokenPaths`) is cut to its origin and that path,
 * dropping the query, the fragment and the rest of the path, as a bare address and inside a
 * markdown link alike. A pasted sign-in link then holds no token: `/sign-in?token=<t>` and
 * `/sign-in/<t>` both become `/sign-in`. A scheme is case-insensitive, so `HTTPS://` is read as
 * an address too, and a cut link comes back with its scheme and host in lower case, as the URL
 * parser gives them. Every other link stays as it was written.
 */

/** An http or https address in running text, its scheme in any case: it ends at a space, a quote, a bracket or a parenthesis. */
const ADDRESS = /https?:\/\/[^\s<>()[\]"']+/gi;

/** Sentence punctuation an address may be followed by, which is no part of it. */
const TRAILING = /[.,;:!?]+$/;

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

/**
 * `text` with every link to a token path cut to its origin and that path; other links and the
 * rest of the text are unchanged. An address the URL parser refuses is left as it is.
 */
export function cutTokenLinks(text: string, tokenPaths: readonly string[]): string {
  const paths = normalizedPaths(tokenPaths);
  if (paths.length === 0 || !/https?:\/\//i.test(text)) return text;
  return text.replace(ADDRESS, (match) => {
    const trailing = TRAILING.exec(match)?.[0] ?? '';
    const address = trailing === '' ? match : match.slice(0, -trailing.length);
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return match;
    }
    const path = tokenPathOf(url.pathname, paths);
    if (path === null) return match;
    return `${url.origin}${path}${trailing}`;
  });
}
