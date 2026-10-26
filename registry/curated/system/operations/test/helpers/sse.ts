/**
 * A reader of `text/event-stream` bytes for the stream tests: frames come back as comments or as
 * events with their id, name and data, each read under a deadline.
 */

export type SseFrame = { readonly comment: string } | { readonly id: string | null; readonly event: string; readonly data: string };

/** Reads one frame at a time from an event stream's body; `next` answers null when the stream has ended. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffered = '';
  private ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** The next frame within `timeoutMs`, null once the stream has ended; throws past the deadline. */
  async next(timeoutMs = 2_000): Promise<SseFrame | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.take();
      if (frame !== undefined) return frame;
      if (this.ended) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no frame within ${timeoutMs} ms (buffered: ${JSON.stringify(this.buffered)})`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), left);
      });
      const read = await Promise.race([this.reader.read(), late]);
      if (timer !== undefined) clearTimeout(timer);
      if (read === 'late') throw new Error(`no frame within ${timeoutMs} ms (buffered: ${JSON.stringify(this.buffered)})`);
      if (read.done) {
        this.ended = true;
        continue;
      }
      this.buffered += this.decoder.decode(read.value, { stream: true });
    }
  }

  /** Every frame that arrives until `stop` answers true or the deadline passes. */
  async until(stop: (frames: SseFrame[]) => boolean, timeoutMs = 2_000): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    const deadline = Date.now() + timeoutMs;
    while (!stop(frames)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`the frames did not arrive within ${timeoutMs} ms: ${JSON.stringify(frames)}`);
      const frame = await this.next(left);
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  /** Whether the stream has ended (after `next` answered null). */
  get done(): boolean {
    return this.ended;
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private take(): SseFrame | undefined {
    const end = this.buffered.indexOf('\n\n');
    if (end === -1) return undefined;
    const raw = this.buffered.slice(0, end);
    this.buffered = this.buffered.slice(end + 2);
    if (raw.startsWith(':')) return { comment: raw.slice(1).trim() };
    let id: string | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    return { id, event, data: data.join('\n') };
  }
}

/** The event frames among `frames`, with their data parsed as JSON. */
export function eventsOf(frames: readonly SseFrame[]): Array<{ id: string | null; event: string; data: unknown }> {
  return frames.flatMap((frame) => ('comment' in frame ? [] : [{ id: frame.id, event: frame.event, data: JSON.parse(frame.data) as unknown }]));
}
