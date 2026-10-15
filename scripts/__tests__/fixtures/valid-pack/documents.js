/** A second entry of the pack, as a package's `./documents` export would load it. */
export function readDocuments() {
  return [];
}

/** A class is a function too: the guard checks each name it is given with `typeof`. */
export class DocumentsReader {}

/** A value that is not a function. */
export const DOCUMENTS_LIMIT = 10;
