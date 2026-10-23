/**
 * @fileoverview Ids: a short tag and 128 random bits in hex from the platform's cryptographic
 * random source (`globalThis.crypto`, which Node 22 and every browser give).
 */

/** The tags an id starts with, one a kind of row. */
export const ID_TAGS = ['tkt', 'msg', 'pic', 'err', 'occ', 'evt', 'ln', 'smp', 'out'] as const;

/** One of the tags an id starts with. */
export type OpsIdTag = (typeof ID_TAGS)[number];

const HEX32 = /^[0-9a-f]{32}$/;

/** `bytes` random bytes as lower-case hex. */
export function randomHex(bytes = 16): string {
  const draw = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(draw);
  let hex = '';
  for (const byte of draw) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A new id: the tag, an underscore and 32 hex characters. */
export function newId(tag: OpsIdTag): string {
  return `${tag}_${randomHex(16)}`;
}

/** Whether `value` is an id of the given tag (or of any tag when none is given). */
export function isTaggedId(value: unknown, tag?: OpsIdTag): value is string {
  if (typeof value !== 'string') return false;
  const underscore = value.indexOf('_');
  if (underscore <= 0) return false;
  const head = value.slice(0, underscore);
  if (tag !== undefined ? head !== tag : !(ID_TAGS as readonly string[]).includes(head)) return false;
  return HEX32.test(value.slice(underscore + 1));
}
