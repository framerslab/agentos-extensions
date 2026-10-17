/**
 * @fileoverview The CRC-32 a ZIP records for an entry's bytes and for the name an Info-ZIP Unicode Path field stands
 * for (APPNOTE 6.3.10 sections 4.4.7 and 4.6.9).
 * @module document-export/archive/crc32
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 ZIP records (ISO-HDLC, reflected 0xEDB88320) of `bytes`, continued from `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
