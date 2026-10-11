/** A body past its cap. */
export class ReadCapExceeded extends Error {
  /** Records the byte cap the response exceeded. */
  constructor(readonly maxBytes: number) {
    super(`the body passes ${maxBytes} bytes`);
    this.name = 'ReadCapExceeded';
  }
}

/** A response's body read under a cap, refused at the header when it states more. */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    try {
      await response.body.cancel();
    } catch {
      // Cleanup failure must not replace the cap error.
    }
    throw new ReadCapExceeded(maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Cleanup failure must not replace the cap error.
      }
      throw new ReadCapExceeded(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
