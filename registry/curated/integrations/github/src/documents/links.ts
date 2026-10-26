/**
 * @fileoverview The GitHub addresses a person pastes, read without a request: a repository, a folder or a file on
 * github.com, and a file on raw.githubusercontent.com. Any other address on GitHub's hosts is refused, so no form of a
 * GitHub address is read as another site's page; an address on any other host is not GitHub's. A text is read as the
 * URL standard reads an address, so every form a browser opens as a GitHub address is answered as one.
 * @module agentos-ext-github/documents/links
 */

/**
 * What a GitHub address names. A folder's and a file's ref and path are one text, `refAndPath`, since a branch name may
 * hold a slash: `GitHubDocumentsConnector.resolveRef` settles where the ref ends. `raw` marks a file address that serves
 * the file's bytes alone (`/raw/` on github.com, or raw.githubusercontent.com). A file's text can be a branch alone
 * (`/blob/release/1.0` names the file `1.0` of `release`, or the branch `release/1.0` and no file); when `resolveRef`
 * settles it with an empty path, the address names a ref and no file, which GitHub answers 404.
 */
export type GitHubLink =
  | { kind: 'github_repository'; owner: string; repo: string }
  | { kind: 'github_folder'; owner: string; repo: string; refAndPath: string }
  | { kind: 'github_file'; owner: string; repo: string; refAndPath: string; raw: boolean }
  | { kind: 'refused' };

/** The hosts of GitHub's site, where a repository, a folder and a file are read. */
const SITE_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/** The host that serves a repository's files as their bytes alone. */
const RAW_HOST = 'raw.githubusercontent.com';

/** GitHub's other hosts, whose addresses name no repository, folder or file read here: gists, the API, archives, uploads. */
const OTHER_HOSTS: ReadonlySet<string> = new Set(['gist.github.com', 'api.github.com', 'codeload.github.com', 'uploads.github.com']);

/** The domain under which GitHub serves its users' content: raw files, gists, release assets, avatars. */
const CONTENT_DOMAIN = 'githubusercontent.com';

/**
 * The domain of GitHub Enterprise Cloud with data residency: each enterprise on a subdomain of its own, its API on
 * `api.<subdomain>.ghe.com`
 * (https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency).
 * Its repositories are not read here.
 */
const ENTERPRISE_DOMAIN = 'ghe.com';

/** First path segments of github.com that name GitHub's own pages, never an account. */
const SITE_PAGES: ReadonlySet<string> = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories', 'dashboard',
  'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'logout', 'marketplace', 'new',
  'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'search', 'security', 'sessions', 'settings', 'site',
  'sponsors', 'stars', 'topics', 'trending', 'users', 'watching',
]);

/** An account's login: letters, digits, dashes and underscores, starting with a letter or a digit. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** A repository's name: letters, digits, dots, dashes and underscores. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A scheme and the slashes before an address's host, as the URL standard reads them
 * (https://url.spec.whatwg.org/#scheme-state), in any case: after `http`, `https`, `ws`, `wss` and `ftp`, special
 * schemes, any run of `/` and `\`, none included (https://url.spec.whatwg.org/#special-authority-slashes-state); after
 * `file`, two of them (https://url.spec.whatwg.org/#file-slash-state), and none when a third follows, since the host is
 * then empty (https://url.spec.whatwg.org/#file-host-state) and the address names no host; after any other scheme
 * (`git://`, `ssh://`), `//`.
 */
const AUTHORITY = /^(?:(?:https?|wss?|ftp):[/\\]*|file:[/\\]{2}(?![/\\])|(?!file:)[a-z][a-z0-9+.-]*:\/\/)/i;

/** The characters the URL standard removes wherever they stand in an address: tab, line feed and carriage return. */
const TAB_OR_NEWLINE = /[\t\n\r]/g;

/** A white space character, as `String.prototype.trim` drops it. */
const WHITE_SPACE = /\s/;

/** An opaque address, such as `mailto:` or `javascript:`, which names no host. */
const OPAQUE = /^[A-Za-z][A-Za-z0-9+-]*:/;

/**
 * Credentials before a host and a path with no scheme, `<user>:<password>@<host>/...`, which reads as an opaque address
 * by the URL standard and which a browser opens as an `https://` address carrying the credentials: an `@` before the
 * first `/`, `?` or `#`, and a `/` after the host. An opaque address of an `@` alone (`mailto:someone@github.com`) has
 * no path and stays opaque.
 */
const CREDENTIALS = /^[^/?#\s@]*@[^/?#\s]*\//;

/** Git's address of a repository over SSH without a scheme: `git@github.com:<owner>/<repo>.git`. */
const SCP = /^([A-Za-z0-9._-]+)@([^/:\s]+):(?!\/)(.*)$/;

/** A refusal: the address is GitHub's, and names nothing read here. */
function refused(): GitHubLink {
  return { kind: 'refused' };
}

/**
 * True for a character dropped around a pasted address: a C0 control or a space, as the URL standard drops them
 * (https://url.spec.whatwg.org/#concept-basic-url-parser), or any other white space, as `String.prototype.trim` does.
 */
function isAround(code: number): boolean {
  return code <= 0x20 || WHITE_SPACE.test(String.fromCharCode(code));
}

/**
 * A pasted text as the URL standard reads an address: without the C0 controls, spaces and other white space around it,
 * and without any tab or newline within it. Read by a loop at each end, so a text of many such characters costs one
 * pass.
 */
function cleaned(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isAround(text.charCodeAt(start))) start += 1;
  while (end > start && isAround(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end).replace(TAB_OR_NEWLINE, '');
}

/**
 * The address a text holds, read as its `https://` form: the scheme and the slashes before the host are dropped
 * whatever the scheme, and a text without one (`github.com/<owner>/<repo>`,
 * `<user>:<password>@github.com/<owner>/<repo>`) is read as if it had it. Null for an opaque address (a scheme the URL
 * standard does not treat as special, without `//`) and for text that is no address.
 */
function addressOf(text: string): URL | null {
  const authority = AUTHORITY.exec(text);
  if (authority === null && OPAQUE.test(text) && !CREDENTIALS.test(text)) return null;
  try {
    return new URL(`https://${authority === null ? text : text.slice(authority[0].length)}`);
  } catch {
    // Text that is no address; the parser's message would quote it.
    return null;
  }
}

/**
 * A host as an address names it, in lower case, without the dots that end it: the URL standard keeps every one
 * (`github.com..` is a host of its own there), and GitHub's hosts are answered whatever their spelling. Read by a loop,
 * so a host of many dots costs one pass.
 */
function hostOf(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end -= 1;
  return host.slice(0, end).toLowerCase();
}

/** True for `domain` itself or a host under it. */
function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * True for a host of GitHub's: its site, its raw files, its other hosts, the hosts of its users' content, and the
 * hosts of GitHub Enterprise Cloud with data residency.
 */
function isGitHubHost(host: string): boolean {
  return SITE_HOSTS.has(host) || host === RAW_HOST || OTHER_HOSTS.has(host) || isUnder(host, CONTENT_DOMAIN) || isUnder(host, ENTERPRISE_DOMAIN);
}

/**
 * An address's path as its segments, each decoded, without a trailing slash; null for a path with an empty segment
 * or an escape that does not decode.
 */
function segmentsOf(pathname: string): string[] | null {
  const raw = pathname.split('/').slice(1);
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const segments: string[] = [];
  for (const segment of raw) {
    if (segment === '') return null;
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return segments;
}

/** True for a text holding a control character, which no ref or path a link names holds. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A folder's or a file's `<ref>/<path>` from the segments after `/tree/`, `/blob/` or `/raw/`, GitHub's own form of a
 * branch by its full name (`refs/heads/<branch>`) read as the branch. Null for none, for another kind of reference
 * (`refs/tags/`, `refs/pull/`), and for a text with an empty, `.` or `..` segment or a control character once decoded.
 */
function refAndPathOf(segments: readonly string[]): string | null {
  let parts = segments;
  if (parts[0] === 'refs') {
    if (parts[1] !== 'heads' || parts.length < 3) return null;
    parts = parts.slice(2);
  }
  const text = parts.join('/');
  if (text === '' || hasControl(text)) return null;
  return text.split('/').every((part) => part !== '' && part !== '.' && part !== '..') ? text : null;
}

/** The owner and the repository of an address's first two segments, `.git` dropped; null when either is not one. */
function repositoryOf(segments: readonly string[]): { owner: string; repo: string } | null {
  const owner = segments[0];
  const name = segments[1];
  const repo = name.endsWith('.git') ? name.slice(0, -'.git'.length) : name;
  if (!OWNER.test(owner) || SITE_PAGES.has(owner.toLowerCase()) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** What a path on github.com names. */
function siteLink(segments: readonly string[]): GitHubLink {
  if (segments.length < 2) return refused();
  const repository = repositoryOf(segments);
  if (repository === null) return refused();
  if (segments.length === 2) return { kind: 'github_repository', ...repository };
  const view = segments[2];
  if (view !== 'tree' && view !== 'blob' && view !== 'raw') return refused();
  const refAndPath = refAndPathOf(segments.slice(3));
  if (refAndPath === null) return refused();
  const named = refAndPath.includes('/');
  // GitHub shows the folder for a blob address that names a ref alone, and answers none for a raw one.
  if (view === 'tree' || (view === 'blob' && !named)) return { kind: 'github_folder', ...repository, refAndPath };
  if (!named) return refused();
  return { kind: 'github_file', ...repository, refAndPath, raw: view === 'raw' };
}

/** What a path on raw.githubusercontent.com names: `/<owner>/<repo>/<ref>/<path>`. */
function rawLink(segments: readonly string[]): GitHubLink {
  if (segments.length < 4) return refused();
  const repository = repositoryOf(segments);
  const refAndPath = refAndPathOf(segments.slice(2));
  if (repository === null || refAndPath === null || !refAndPath.includes('/')) return refused();
  return { kind: 'github_file', ...repository, refAndPath, raw: true };
}

/**
 * What a GitHub address names, read without a request. Null for an address whose host is not GitHub's, and for text
 * that is no address; `refused` for an address on GitHub's hosts that names no repository, folder or file read here: an
 * account, an issue, a pull request, a wiki, a release, a commit, a tag by its full name (`refs/tags/<tag>`), a gist,
 * the API, an archive, GitHub's own pages, an address that carries credentials (with a scheme or without one:
 * `<user>:<password>@github.com/...`), a host of GitHub Enterprise Cloud with data residency (`<subdomain>.ghe.com`),
 * and a host other than github.com, www.github.com and raw.githubusercontent.com. The scheme (or its absence), a port,
 * the dots that end a host, `.git`, a trailing slash, a query and a fragment are ignored, and so is the `git` user of
 * an SSH address (`git@github.com:<owner>/<repo>.git`).
 *
 * The text is read as the URL standard reads an address: the C0 controls and spaces around it, and any other white
 * space there, are dropped, and every tab and newline in it; after `http`, `https`, `ws`, `wss` and `ftp` any run of
 * `/` and `\` stands before the host, none included (`https:github.com/<owner>/<repo>`,
 * `https:\\github.com\<owner>\<repo>`), as a browser opens such an address; after `file`, two of them; after any
 * other scheme, `//`. A backslash in the path is a slash.
 *
 * A folder's and a file's ref and path are answered as one text, each segment decoded, since a branch name may hold a
 * slash; GitHub's form of a branch by its full name, `refs/heads/<branch>`, is read as the branch. A `/blob/` address
 * whose text has no slash names a ref alone and is a folder, as GitHub shows it (its `/blob/<ref>` redirects to
 * `/tree/<ref>`); one whose text has a slash is a file, which `resolveRef` may settle as a ref alone (an empty path).
 *
 * @param text The address as pasted; the controls and spaces around it are dropped.
 * @throws TypeError when `text` is not a string.
 */
export function parseGitHubLink(text: string): GitHubLink | null {
  if (typeof text !== 'string') throw new TypeError('a link is a string');
  const pasted = cleaned(text);
  if (pasted === '') return null;
  const scp = SCP.exec(pasted);
  if (scp !== null) {
    const host = hostOf(scp[2]);
    if (!isGitHubHost(host)) return null;
    if (scp[1] !== 'git' || !SITE_HOSTS.has(host)) return refused();
    const address = addressOf(`${host}/${scp[3]}`);
    const segments = address === null ? null : segmentsOf(address.pathname);
    return segments === null ? refused() : siteLink(segments);
  }
  const address = addressOf(pasted);
  if (address === null) return null;
  const host = hostOf(address.hostname);
  if (!isGitHubHost(host)) return null;
  // A token in an address is a secret, never something to read a repository with.
  if ((address.username !== '' && address.username !== 'git') || address.password !== '') return refused();
  const segments = segmentsOf(address.pathname);
  if (segments === null) return refused();
  if (SITE_HOSTS.has(host)) return siteLink(segments);
  if (host === RAW_HOST) return rawLink(segments);
  return refused();
}
