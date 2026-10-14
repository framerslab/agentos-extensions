/**
 * @fileoverview Drive's REST API for files a person picked, over an injected fetch: a file's metadata, its export or
 * download read under a byte cap, and the connected account. A refusal throws {@link DriveRequestError} with Google's
 * status, reason and domain.
 * @module agentos-ext-google-drive/drive
 */

import { readCapped } from '@framers/agentos-ext-account-sources';

/** Drive's API origin, under which `/drive/v3` lives. */
export const DRIVE_BASE_URL = 'https://www.googleapis.com';

/** What each Google Workspace type is exported as: a Doc as Markdown, a Sheet's first sheet as CSV, a Slides deck as text. */
export const EXPORT_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** The metadata a read uses. */
const FILE_FIELDS = 'id,name,mimeType,version,modifiedTime,ownedByMe,size,webViewLink,trashed';

/** The most bytes read of a metadata or account answer. */
const ANSWER_BYTES = 1_048_576;

/** The most bytes read of an error answer for its reason. */
const ERROR_BYTES = 65_536;

/** Where and how a Drive call is made. */
export interface DriveCallOptions {
  /** The fetch the call is made with; the global fetch when absent. */
  fetchImpl?: typeof fetch;
  /** Drive's API origin, under which `/drive/v3` lives; Google's when absent. A test passes its stand-in's. */
  baseUrl?: string;
  /** Cancels the call. */
  signal?: AbortSignal;
}

/** A file's metadata as Drive answers it. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Drive's version of the file, which reflects every change made to it on the server. */
  version: string | null;
  /** When anyone last changed the file, RFC 3339. */
  modifiedTime: string | null;
  /** Whether the person owns the file; null where Drive does not say, as for an item in a shared drive. */
  ownedByMe: boolean | null;
  /** The file's size in bytes, when Drive states one. */
  size: number | null;
  /** The address that opens the file in Google's editor or viewer. */
  webViewLink: string | null;
  /** Whether the file is in its owner's trash. */
  trashed: boolean;
}

/** The connected account as Drive's `about` answers it. */
export interface DriveAccount {
  /** The account's address, or an empty string where Google leaves it out. */
  emailAddress: string;
  /** The account's display name, or an empty string where Google leaves it out. */
  displayName: string;
}

/** Drive refused a call: the HTTP status and, when its answer named them, Google's error reason and domain. */
export class DriveRequestError extends Error {
  /**
   * @param status The HTTP status Drive answered.
   * @param reason Google's reason, such as `notFound` or `userRateLimitExceeded`, when the answer gave one.
   * @param domain Google's error domain, such as `global` or `usageLimits`, when the answer gave one.
   */
  constructor(readonly status: number, readonly reason?: string, readonly domain?: string) {
    super(`Drive answered ${status}${reason === undefined ? '' : ` (${reason})`}`);
    this.name = 'DriveRequestError';
  }
}

/** Whether an id can name one file in a request's path: an empty id would name Drive's file listing, and a dot segment would be folded out of the address. */
export function isDriveFileId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..';
}

/** A word of Google's error answer, kept when it is an identifier. */
function word(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
}

/** A string field, or null when the answer has none. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The refusal of a call that did not succeed, with Google's reason and domain read from its answer when it has them. */
async function refusal(response: Response): Promise<DriveRequestError> {
  try {
    const answer = JSON.parse(new TextDecoder().decode(await readCapped(response, ERROR_BYTES))) as { error?: { errors?: Array<{ reason?: unknown; domain?: unknown }> } } | null;
    const first = answer?.error?.errors?.[0];
    return new DriveRequestError(response.status, word(first?.reason), word(first?.domain));
  } catch {
    // An answer that is not Google's error object leaves the reason unknown; the status still tells the caller.
    return new DriveRequestError(response.status);
  }
}

/** Calls Drive with the access token; answers the response of a success and throws the refusal of anything else. */
async function driveGet(token: string, path: string, options: DriveCallOptions): Promise<Response> {
  const base = (options.baseUrl ?? DRIVE_BASE_URL).replace(/\/+$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: options.signal });
  if (!response.ok) throw await refusal(response);
  return response;
}

/** A JSON object answer, read under a cap. */
async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(new TextDecoder().decode(await readCapped(response, ANSWER_BYTES)));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Drive answered something other than an object');
  return value as Record<string, unknown>;
}

/** A file's path in the API. Throws a `TypeError` for an id that cannot name one file. */
function filePath(id: string): string {
  if (!isDriveFileId(id)) throw new TypeError('a Drive file id is required');
  return `/drive/v3/files/${encodeURIComponent(id)}`;
}

/**
 * A file's metadata: its name, type, version, owner, size, link and whether it is trashed. Asks with
 * `supportsAllDrives=true`, without which Drive answers an item of a shared drive as not found.
 */
export async function driveFile(token: string, id: string, options: DriveCallOptions = {}): Promise<DriveFile> {
  const answer = await readObject(await driveGet(token, `${filePath(id)}?${new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' })}`, options));
  const fileId = text(answer.id);
  const name = text(answer.name);
  const mimeType = text(answer.mimeType);
  if (fileId === null || name === null || mimeType === null) throw new Error('Drive answered a file without its id, name or type');
  const size = text(answer.size);
  return {
    id: fileId,
    name,
    mimeType,
    version: text(answer.version),
    modifiedTime: text(answer.modifiedTime),
    ownedByMe: typeof answer.ownedByMe === 'boolean' ? answer.ownedByMe : null,
    size: size !== null && /^\d+$/.test(size) ? Number(size) : null,
    webViewLink: text(answer.webViewLink),
    trashed: answer.trashed === true,
  };
}

/**
 * A Google Workspace file exported as `mimeType` (see {@link EXPORT_TYPES}), read up to `maxBytes`. Google refuses an
 * export past 10 MB; a longer answer than `maxBytes` throws `ReadCapExceeded`.
 */
export async function exportFile(token: string, id: string, mimeType: string, maxBytes: number, options: DriveCallOptions = {}): Promise<Uint8Array> {
  return readCapped(await driveGet(token, `${filePath(id)}/export?${new URLSearchParams({ mimeType })}`, options), maxBytes);
}

/** A file's own bytes (`alt=media`), read up to `maxBytes`; a longer answer throws `ReadCapExceeded`. */
export async function downloadFile(token: string, id: string, maxBytes: number, options: DriveCallOptions = {}): Promise<Uint8Array> {
  return readCapped(await driveGet(token, `${filePath(id)}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`, options), maxBytes);
}

/** The connected account's address and name from Drive's `about`, which the `drive.file` scope may read, so a caller can show which account is connected. */
export async function driveAccount(token: string, options: DriveCallOptions = {}): Promise<DriveAccount> {
  const answer = await readObject(await driveGet(token, `/drive/v3/about?${new URLSearchParams({ fields: 'user(emailAddress,displayName)' })}`, options));
  const user: Record<string, unknown> = answer.user !== null && typeof answer.user === 'object' ? (answer.user as Record<string, unknown>) : {};
  return { emailAddress: text(user.emailAddress) ?? '', displayName: text(user.displayName) ?? '' };
}
