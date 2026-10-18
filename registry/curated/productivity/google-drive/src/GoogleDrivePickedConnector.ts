/**
 * @fileoverview The files a person picked in Google Drive as an account source: each read by id under the
 * `drive.file` scope, a Google Workspace file exported and any other downloaded, and a file that can no longer be
 * read answered gone with its reason.
 * @module agentos-ext-google-drive/GoogleDrivePickedConnector
 */

import { ReadCapExceeded, type AccountSourceConnector, type SourceChanges, type SourceGone, type SourceItem, type SourceRead, type SourceSelection } from '@framers/agentos-ext-account-sources';
import {
  downloadFile, driveFile, DriveNoAnswer, DriveRequestError, EXPORT_TYPES, exportFile, isDriveFileId, type DriveCallOptions, type DriveFile,
} from './drive.js';

/** The kind each read's `SourceRef` carries. */
const KIND = 'google_drive';

/** The prefix of Google Workspace types, which have no bytes of their own to download. */
const WORKSPACE_TYPE = 'application/vnd.google-apps.';

/** Google's reasons for its rate and quota limits, which pass. */
const LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);

/**
 * Google's reasons for a refusal of every file of the account rather than of one, which pass: `domainPolicy`, "the
 * policy for the user's domain doesn't allow access to Drive by your app"
 * (https://developers.google.com/workspace/drive/api/guides/handle-errors#domain-policy).
 */
const ACCOUNT_REASONS = new Set(['domainPolicy']);

/** How the connector reads. */
export interface GoogleDrivePickedOptions {
  /** Answers a file whose `ownedByMe` is not true as `not_owned`, without reading its content. */
  ownedOnly: boolean;
  /** The most bytes a file's content may take; a file past it is answered `removed`. */
  maxFileBytes: number;
  /** The fetch Drive is called with; the global fetch when absent. */
  fetchImpl?: typeof fetch;
  /** Drive's API origin; Google's when absent. A test passes its stand-in's. */
  baseUrl?: string;
  /**
   * How long each Drive call may take, the reading of its answer included, in whole milliseconds from 1 to
   * 2,147,483,647; `DRIVE_TIMEOUT_MS` (60 seconds) when absent. Each metadata read, export and download has its own.
   */
  timeoutMs?: number;
  /** What `revoke()` calls, such as the caller's `GoogleOAuthFlow.forget(key)`. */
  revoke?: () => Promise<unknown>;
}

/** The type a Google Workspace file is exported as, or undefined for any other file. */
function exportTypeOf(mimeType: string): string | undefined {
  return Object.hasOwn(EXPORT_TYPES, mimeType) ? EXPORT_TYPES[mimeType] : undefined;
}

/**
 * Why Drive's refusal means the file cannot be read, or null for anything that says nothing about the file, which the
 * caller sees thrown and tries again: a rate or quota limit (Drive answers them as 403 or 429), a refusal of every file
 * of the account (`domainPolicy`), a token Drive refused, a server's fault, an answer that is not Google's error object,
 * such as a proxy's or a wrong address's 404, a call that got no answer (`DriveNoAnswer`), and a `ReadCapExceeded`. A
 * read past its cap answers a file gone only when it is the file's content past `maxFileBytes`, which `content` answers
 * `removed` itself; a metadata answer past its 1 MiB cap, such as a proxy's page, throws.
 */
function goneReasonOf(error: unknown): SourceGone['reason'] | null {
  if (!(error instanceof DriveRequestError)) return null;
  const { status, reason, domain } = error;
  if (reason === undefined) return null;
  if (status === 404) return 'removed';
  if (status !== 403 || domain === 'usageLimits' || LIMIT_REASONS.has(reason) || ACCOUNT_REASONS.has(reason)) return null;
  return reason === 'exportSizeLimitExceeded' ? 'removed' : 'no_access';
}

/**
 * Throws `DriveNoAnswer` (`cancelled`) for a call whose signal has already aborted. Each call runs it first, before it
 * checks its inputs, asks for a token or calls Drive, so every aborted call answers alike.
 */
function notCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DriveNoAnswer('cancelled');
}

/** A file as an item of the account, under the id it was asked by; its size where reading it downloads that size. */
function itemOf(id: string, file: DriveFile): SourceItem {
  return { id, title: file.name, size: exportTypeOf(file.mimeType) === undefined ? file.size : null, version: file.version };
}

/** The refusal of a cursor of another shape. It quotes nothing of the cursor. */
const NOT_A_CURSOR = 'the cursor is not a JSON object of file ids to versions';

/**
 * The cursor's versions by file id: a JSON object of each file's id to the version it was read at. Throws a
 * `TypeError` for a cursor of another shape, JSON or not.
 */
function versionsOf(cursor: string | null): Map<string, string | null> {
  const versions = new Map<string, string | null>();
  if (cursor === null) return versions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    // The parser's own error quotes part of the cursor.
    throw new TypeError(NOT_A_CURSOR);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(NOT_A_CURSOR);
  for (const [id, version] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof version === 'string' || version === null) versions.set(id, version);
    else throw new TypeError(NOT_A_CURSOR);
  }
  return versions;
}

/**
 * The files a person picked in Google Drive, read by id under the `drive.file` scope. A Google Doc is exported as
 * Markdown, a Sheet as CSV and a Slides deck as text; any other file is downloaded; every file is answered as bytes
 * with the type it was read as, for the caller's loader of that type. A file that can no longer be read is answered
 * gone: `removed` when Drive answers it not found, when it is in the trash, when it is a Google Workspace type with no
 * export or when its content is past Google's 10 MB export cap or `maxFileBytes`; `no_access` when Drive refuses it;
PLACEHOLDER_DOC
 *
export class GoogleDrivePickedConnector implements AccountSourceConnector {
  /** Each read's `SourceRef.kind`. */
  readonly kind = KIND;

  /**
   * @param accessToken Answers an access token for the grant, such as the caller's `GoogleOAuthFlow.accessToken(key)`.
   * @param options Whether only the person's own files are read, the byte cap, and where Drive is called.
   */
  constructor(private readonly accessToken: () => Promise<string>, private readonly options: GoogleDrivePickedOptions) {}

  /** Lists the picked files with their versions, and those that can no longer be read. */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    notCancelled(signal);
    let token: string | undefined;
    const items: SourceItem[] = [];
    const gone: SourceGone[] = [];
    for (const id of selection.ids) {
      if (!isDriveFileId(id)) {
        gone.push({ id, reason: 'removed' });
        continue;
      }
      token ??= await this.accessToken();
      const found = await this.metadata(token, id, signal);
      if ('reason' in found) gone.push(found);
      else items.push(itemOf(id, found));
    }
    return { items, gone };
  }

  /** Reads one picked file: its metadata first, then its export or its bytes, with its attribution; or why it is gone. */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    notCancelled(signal);
    if (!isDriveFileId(item.id)) return { id: item.id, reason: 'removed' };
    const token = await this.accessToken();
    const found = await this.metadata(token, item.id, signal);
    if ('reason' in found) return found;
    const content = await this.content(token, found, signal);
    if (typeof content === 'string') return { id: item.id, reason: content };
    return {
      item: itemOf(item.id, found),
      content,
      ref: { kind: KIND, title: found.name, url: found.webViewLink, version: found.version, readAt: new Date().toISOString() },
    };
  }

  /**
   * The picked files whose `version` is not the one the cursor holds (every readable file when the cursor is null),
   * those that can no longer be read, and the next cursor: a JSON object of each readable file's id to its version.
   * Throws a `TypeError` that quotes nothing of the cursor for a cursor of another shape, JSON or not, before Drive is
   * asked.
   */
  async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges> {
    notCancelled(signal);
    const before = versionsOf(cursor);
    const { items, gone } = await this.list(selection, signal);
    const changed = items.filter((item) => !before.has(item.id) || before.get(item.id) !== item.version);
    return { changed, gone, cursor: JSON.stringify(Object.fromEntries(items.map((item): [string, string | null] => [item.id, item.version]))) };
  }

  /** Ends the grant through the `revoke` the connector was given, which revokes it at Google and clears it where it is kept. */
  async revoke(): Promise<void> {
    if (this.options.revoke === undefined) throw new Error('no revoke function was given to this connector');
    await this.options.revoke();
  }

  /** Where Drive is called, with this call's signal and the connector's deadline. */
  private call(signal?: AbortSignal): DriveCallOptions {
    return { fetchImpl: this.options.fetchImpl, baseUrl: this.options.baseUrl, signal, timeoutMs: this.options.timeoutMs };
  }

  /** A picked file's metadata, or why it can no longer be read. */
  private async metadata(token: string, id: string, signal?: AbortSignal): Promise<DriveFile | SourceGone> {
    const found = await driveFile(token, id, this.call(signal)).catch((error: unknown): SourceGone => {
      const reason = goneReasonOf(error);
      if (reason === null) throw error;
      return { id, reason };
    });
    if ('reason' in found) return found;
    if (found.trashed) return { id, reason: 'removed' };
    if (this.options.ownedOnly && found.ownedByMe !== true) return { id, reason: 'not_owned' };
    return found;
  }

  /** A file's content, exported or downloaded under the byte cap, or why it cannot be read. */
  private async content(token: string, file: DriveFile, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string } | SourceGone['reason']> {
    const exportType = exportTypeOf(file.mimeType);
    try {
      if (exportType !== undefined) return { bytes: await exportFile(token, file.id, exportType, this.options.maxFileBytes, this.call(signal)), mediaType: exportType };
      // A folder, a shortcut or another Google Workspace type has no export here and no bytes to download.
      if (file.mimeType.startsWith(WORKSPACE_TYPE)) return 'removed';
      if (file.size !== null && file.size > this.options.maxFileBytes) return 'removed';
      return { bytes: await downloadFile(token, file.id, this.options.maxFileBytes, this.call(signal)), mediaType: file.mimeType };
    } catch (error) {
      // The file's content past maxFileBytes: the one byte cap that answers a file gone.
      if (error instanceof ReadCapExceeded) return 'removed';
      const reason = goneReasonOf(error);
      if (reason === null) throw error;
      return reason;
    }
  }
}
