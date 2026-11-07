import { randomBytes } from 'node:crypto';

/** `bytes` random bytes as lower-case hexadecimal: run ids (16 bytes) and claim tokens (16 bytes, a 128-bit token). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
