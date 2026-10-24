/**
 * @fileoverview The GitHub addresses a person pastes, read without a request: a repository, a folder or a file on
 * github.com, and a file on raw.githubusercontent.com. Any other address on GitHub's hosts is refused, so no form of a
 * GitHub address is read as another site's page; an address on any other host is not GitHub's.
 * @module agentos-ext-github/documents/links
 */

/**
 * What a GitHub address names. A folder's and a file's ref and path are one text, `refAndPath`, since a branch name may
 * hold a slash: `GitHubDocumentsConnector.resolveRef` settles where the ref ends. `raw` marks a file address that serves
 * the file's bytes alone (`/raw/` on github.com, or raw.githubusercontent.com).
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

/** An address with a scheme and an authority (`https://`, `http://`, `git://`, `ssh://`), whatever the scheme. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** An opaque address, such as `mailto:` or `javascript:`, which names no host. */
const OPAQUE = /^[A-Za-z][A-Za-z0-9+-]*:/;

/** Git's address of a repository over SSH without a scheme: `git@github.com:<owner>/<repo>.git`. */
const SCP = /^([A-Za-z0-9._-]+)@([^/:\s]+):(?!\/)(.*)$/;

/** A refusal: the address is GitHub's, and names nothing read here. */
function refused(): GitHubLink {
  return { kind: 'refused' };
}

/**
 * The address a text holds, read as its `https://` form: the scheme is dropped whatever it is, and a text without one
 * (`github.com/<owner>/<repo>`) is read as if it had it. Null for an opaque address and for text that is no address.
 */
function addressOf(text: string): URL | null {
  const scheme = SCHEME.exec(text);
  if (scheme === null && OPAQUE.test(text)) return null;
  try {
    return new URL(`https://${scheme === null ? text : text.slice(scheme[0].length)}`);
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

/** True for a host of GitHub's: its site, its raw files, its other hosts and the hosts of its users' content. */
function isGitHubHost(host: string): boolean {
  return SITE_HOSTS.has(host) || host === RAW_HOST || OTHER_HOSTS.has(host) || host === CONTENT_DOMAIN || host.endsWith(`.${CONTENT_DOMAIN}`);
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
 * account, an issue, a pull request, a wiki, a release, a commit, a tag, a gist, the API, an archive, GitHub's own
 * pages, an address that carries credentials, and a host other than github.com, www.github.com and
 * raw.githubusercontent.com. The scheme (or its absence), a port, the dots that end a host, `.git`, a trailing slash, a
 * query and a fragment are ignored, and so is the `git` user of an SSH address (`git@github.com:<owner>/<repo>.git`).
 *
 * A folder's and a file's ref and path are answered as one text, each segment decoded, since a branch name may hold a
 * slash; GitHub's form of a branch by its full name, `refs/heads/<branch>`, is read as the branch. A `/blob/` address
 * that names a ref alone is a folder, as GitHub shows it.
 *
 * @param text The address as pasted; spaces around it are dropped.
 * @throws TypeError when `text` is not a string.
 */
export function parseGitHubLink(text: string): GitHubLink | null {
  if (typeof text !== 'string') throw new TypeError('a link is a string');
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const scp = SCP.exec(trimmed);
  if (scp !== null) {
    const host = hostOf(scp[2]);
    if (!isGitHubHost(host)) return null;
    if (scp[1] !== 'git' || !SITE_HOSTS.has(host)) return refused();
    const address = addressOf(`${host}/${scp[3]}`);
    const segments = address === null ? null : segmentsOf(address.pathname);
    return segments === null ? refused() : siteLink(segments);
  }
  const address = addressOf(trimmed);
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
