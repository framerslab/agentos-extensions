/**
 * @fileoverview The Drive and Docs addresses a person pastes, read without a request: a file, a folder or a shared
 * drive by its id. Any other address on Drive's and Docs' hosts is refused, so no form of a Drive address is read as
 * another site's page; an address on any other host is not Drive's.
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

/** An address with a scheme and an authority (`https://`, `http://`), whatever the scheme. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** An opaque address, such as `mailto:` or `javascript:`, which names no host. */
const OPAQUE = /^[A-Za-z][A-Za-z0-9+-]*:/;

/** A refusal: the address is Drive's or Docs', and names no item read here. */
function refused(): DriveLink {
  return { kind: 'refused' };
}

/**
 * The address a text holds, read as its `https://` form: the scheme is dropped whatever it is, and a text without one
 * (`drive.google.com/file/d/<id>`) is read as if it had it. Null for an opaque address and for text that is no address.
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
 * without `/edit`, `/view` or any word after the id), `/file/d/<id>`, `/open?id=<id>`, `/uc?id=<id>` and
 * `drive.usercontent.google.com/download?id=<id>`. A folder: `/drive/folders/<id>`. A shared drive:
 * `/drive/shared-drives/<id>`. A signed-in account's index (`/u/<n>/`) is allowed where Drive and Docs write it. Any
 * other address on those hosts is `refused`: a Form, a Drawing, the publish-to-the-web form (`/d/e/<id>/pub`, whose
 * id is not the file's), Drive's own pages, and an address that carries credentials. The scheme (or its absence), a
 * port, the dots that end a host (the URL standard keeps every one), a trailing slash, a fragment and any query but the
 * `id` named are ignored. An id is the Docs API's rule, `/d/([a-zA-Z0-9-_]+)`, applied to the whole segment.
 *
 * @param text The address as pasted; spaces around it are dropped.
 * @throws TypeError when `text` is not a string.
 */
export function parseDriveLink(text: string): DriveLink | null {
  if (typeof text !== 'string') throw new TypeError('a link is a string');
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const address = addressOf(trimmed);
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
