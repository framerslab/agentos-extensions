/**
 * @fileoverview The relative paths of an import selection, checked one component at a time.
 * @module document-export/import/paths
 */

/**
 * A path or component refused as unsafe. Its message is the fixed code `unsafe_path` and carries nothing of the name
 * it was given, so a refusal can be logged or shown without the name.
 */
export class ImportPathError extends Error {
  /** The refusal's fixed code, the same as its message. */
  readonly code = 'unsafe_path';

  constructor() {
    super('unsafe_path');
    this.name = 'ImportPathError';
  }
}

/**
 * One component of a relative path, returned as given once it is safe. Nothing is decoded, normalised or trimmed: a
 * literal `%2F` stays those three characters, a decomposed `é` stays decomposed and spaces at either end stay. The
 * component is display text, never a filesystem path to resolve.
 *
 * @throws {ImportPathError} When the component is empty, `.` or `..`, holds a slash, a backslash or a null
 * character, or begins with a drive prefix such as `C:`.
 */
export function safeComponent(value: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new ImportPathError();
  }
  return value;
}

/**
 * The components of a slash-separated relative path, each checked by {@link safeComponent}, as a frozen array. A
 * leading or trailing slash, or two slashes together, leaves an empty component, so an absolute path is refused with
 * the rest.
 *
 * @throws {ImportPathError} When any component is unsafe.
 */
export function relativeParts(value: string): readonly string[] {
  return Object.freeze(value.split('/').map((part) => safeComponent(part)));
}
