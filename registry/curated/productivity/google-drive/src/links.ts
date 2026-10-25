/**
 * @fileoverview The Drive and Docs addresses a person pastes, read without a request: a file, a folder or a shared
 * drive by its id. Any other address on Drive's and Docs' hosts is refused, so no form of a Drive address is read as
 * another site's page; an address on any other host is not Drive's. A text is read as the URL standard reads an
 * address, so every form a browser opens as a Drive address is answered as one.
 * @module agentos-ext-google-drive/links
 */

/**
 * What a Drive or Docs address names. `/open?id=` names a file or a folder alike and is answered `drive_file`: a
 * caller tells the two apart by the item's metadata (`driveFile`'s `mimeType`). A shared drive's root may also be
 * linked as a folder (`/drive/folders/<id>`), which only its metadata tells.
 */
export type DriveLink =
  | { kind: 'drive_file'; id: string }
  | { kind: 'drive_folder'; id: string }
  | { kind: 'shared_drive'; id: string }
  | { kind: 'refused' };

/** Google Docs, Sheets and Slides. */
const DOCS_HOST = 'docs.google.com';

/** Google Drive. */
const DRIVE_HOST = 'drive.google.com';

/** The host Drive serves a file's download from. */
const DOWNLOAD_HOST = 'drive.usercontent.google.com';

/** The path words before `/d/<id>` that name a file: a Doc, a Sheet, a Slides deck, and Drive's own file view. */
const FILE_WORDS: ReadonlySet<string> = new Set(['document', 'spreadsheets', 'presentation', 'file']);

/**
 * An id as Drive writes it in an address: letters, digits, dashes and underscores, the Docs API's own rule for a
 * document's id (https://developers.google.com/workspace/docs/api/concepts/document). It is never empty, `.` or `..`,
 * so it names one item in a request's path.
 */
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;

/** The publish-to-the-web form's word in place of an id (`/d/e/<publish id>/pub`), which names no Drive item. */
const PUBLISHED = 'e';

/** The index of a signed-in account in an address (`/u/<n>/`). */
const ACCOUNT_INDEX = /^\d+$/;

/**
 * A scheme and the slashes before an address's host, as the URL standard reads them
 * (https://url.spec.whatwg.org/#scheme-state), in any case: after `http`, `https`, `ws`, `wss` and `ftp`, special
 * schemes, any run of `/` and `\`, none included (https://url.spec.whatwg.org/#special-authority-slashes-state); after
 * `file`, two of them (https://url.spec.whatwg.org/#file-slash-state); after any other scheme, `//`.
 */
const AUTHORITY = /^(?:(?:https?|wss?|ftp):[/\\]*|file:[/\\]{2}|[a-z][a-z0-9+.-]*:\/\/)/i;

/** The characters the URL standard removes wherever they stand in an address: tab, line feed and carriage return. */
const TAB_OR_NEWLINE = /[\t\n\r]/g;

/** A white space character, as `String.prototype.trim` drops it. */
const WHITE_SPACE = /\s/;

/** An opaque address, such as `mailto:` or `javascript:`, which names no host. */
const OPAQUE = /^[A-Za-z][A-Za-z0-9+-]*:/;

/**
 * Credentials before a host and a path with no scheme, `<user>:<password>@<host>/...`, which reads as an opaque address
 * by the URL standard and which a browser opens as an `https://` address carrying the credentials: an `@` before the
 * first `/`, `?` or `#`, and a `/` after the host. An opaque address of an `@` alone
 * (`mailto:someone@drive.google.com`) has no path and stays opaque.
 */
const CREDENTIALS = /^[^/?#\s@]*@[^/?#\s]*\//;

/** A refusal: the address is Drive's or Docs', and names no item read here. */
function refused(): DriveLink {
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
 * whatever the scheme, and a text without one (`drive.google.com/file/d/<id>`,
 * `<user>:<password>@drive.google.com/file/d/<id>`) is read as if it had it. Null for an opaque address (a scheme the
 * URL standard does not treat as special, without `//`) and for text that is no address.
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
 * (`drive.google.com..` is a host of its own there), and Drive's hosts are answered whatever their spelling. Read by a
 * loop, so a host of many dots costs one pass.
 */
function hostOf(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end -= 1;
  return host.slice(0, end).toLowerCase();
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

/** The segments without a signed-in account's index at `at` (`u/<n>`), or as they are when none stands there. */
function withoutAccount(segments: readonly string[], at: number): readonly string[] {
  return segments[at] === 'u' && ACCOUNT_INDEX.test(segments[at + 1] ?? '') ? [...segments.slice(0, at), ...segments.slice(at + 2)] : segments;
}

/** A file named by the `id` of an address's query (`/open?id=`, `/uc?id=`, `/download?id=`). */
function fileOfQuery(address: URL): DriveLink {
  const id = address.searchParams.get('id') ?? '';
  return DRIVE_ID.test(id) ? { kind: 'drive_file', id } : refused();
}

/**
 * A folder named by the `id` of an address's query: Drive's older `/folderview?id=<id>`, which Drive answers with a
 * redirect to `/drive/folders/<id>` for the same id.
 */
function folderOfQuery(address: URL): DriveLink {
  const id = address.searchParams.get('id') ?? '';
  return DRIVE_ID.test(id) ? { kind: 'drive_folder', id } : refused();
}

/** A file named by `/<word>/d/<id>[/...]`, a signed-in account's index allowed before `/d/`. */
function fileOfPath(segments: readonly string[]): DriveLink {
  const path = withoutAccount(segments, 1);
  const id = path[2] ?? '';
  if (!FILE_WORDS.has(path[0]) || path[1] !== 'd' || id === PUBLISHED || !DRIVE_ID.test(id)) return refused();
  return { kind: 'drive_file', id };
}

/** What a path on docs.google.com or drive.google.com names. */
function editorLink(segments: readonly string[], address: URL): DriveLink {
  if (segments.length === 1 && (segments[0] === 'open' || segments[0] === 'uc')) return fileOfQuery(address);
  if (segments.length === 1 && segments[0] === 'folderview') return folderOfQuery(address);
  if (segments[0] !== 'drive') return fileOfPath(segments);
  const path = withoutAccount(segments, 1);
  const id = path[2] ?? '';
  if (path.length !== 3 || !DRIVE_ID.test(id)) return refused();
  if (path[1] === 'folders') return { kind: 'drive_folder', id };
  if (path[1] === 'shared-drives') return { kind: 'shared_drive', id };
  return refused();
}

/**
 * What a Drive or Docs address names, read without a request. Null for an address whose host is not
 * `docs.google.com`, `drive.google.com` or `drive.usercontent.google.com`, and for text that is no address. A file:
 * a Doc, Sheet or Slides address (`/document/d/<id>`, `/spreadsheets/d/<id>`, `/presentation/d/<id>`, with or
 * without `/edit`, `/view` or any word after the id), `/file/d/<id>`, `/open?id=<id>` and `/uc?id=<id>` on
 * docs.google.com and drive.google.com, and `/download?id=<id>` and `/uc?id=<id>` on drive.usercontent.google.com
 * (its `/uc` redirects to its `/download` for the same id). A folder: `/drive/folders/<id>`, and `/folderview?id=<id>`
 * on docs.google.com and drive.google.com, which Drive redirects to it. A shared drive: `/drive/shared-drives/<id>`. A
 * signed-in account's index (`/u/<n>/`) is allowed where Drive and Docs write it. Any other address on those hosts is
 * `refused`: a Form, a Drawing, the publish-to-the-web form (`/d/e/<id>/pub`, whose id is not the file's), Drive's own
 * pages, and an address that carries credentials, with a scheme or without one
 * (`<user>:<password>@drive.google.com/...`). The scheme (or its absence), a port, the dots that end a host (the URL
 * standard keeps every one), a trailing slash, a fragment and any query but the `id` named are ignored. An id is the
 * Docs API's rule, `/d/([a-zA-Z0-9-_]+)`, applied to the whole segment.
 *
 * The text is read as the URL standard reads an address: the C0 controls and spaces around it, and any other white
 * space there, are dropped, and every tab and newline in it; after `http`, `https`, `ws`, `wss` and `ftp` any run of
 * `/` and `\` stands before the host, none included (`https:drive.google.com/file/d/<id>`,
 * `https:\\drive.google.com\file\d\<id>`), as a browser opens such an address; after `file`, two of them; after any
 * other scheme, `//`. A backslash in the path is a slash.
 *
 * @param text The address as pasted; the controls and spaces around it are dropped.
 * @throws TypeError when `text` is not a string.
 */
export function parseDriveLink(text: string): DriveLink | null {
  if (typeof text !== 'string') throw new TypeError('a link is a string');
  const pasted = cleaned(text);
  if (pasted === '') return null;
  const address = addressOf(pasted);
  if (address === null) return null;
  const host = hostOf(address.hostname);
  if (host !== DOCS_HOST && host !== DRIVE_HOST && host !== DOWNLOAD_HOST) return null;
  if (address.username !== '' || address.password !== '') return refused();
  const segments = segmentsOf(address.pathname);
  if (segments === null) return refused();
  if (host !== DOWNLOAD_HOST) return editorLink(segments, address);
  const path = withoutAccount(segments, 0);
  return path.length === 1 && (path[0] === 'download' || path[0] === 'uc') ? fileOfQuery(address) : refused();
}
