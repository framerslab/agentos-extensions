import type { RawData, WebSocket } from 'ws';
import { ChannelMessage, type AckMessage, type CommandMessage, type JobMessage, type ReportMessage } from '../protocol.js';

/** How long a command waits for the container's acknowledgement. */
export const ACK_TIMEOUT_MS = 10_000;
/** How often the scheduler pings a channel; a channel that has not answered the last ping by the next is cut. */
export const HEARTBEAT_MS = 15_000;

/**
 * The scheduler's end of one run's command channel: it sends the job, sends commands and waits for their
 * acknowledgements, and hands the container's reports on. A message that does not parse, or that is not the container's
 * to send (a job, a command), is dropped. A socket that stops answering pings is cut, so a link that broke without a
 * close never holds the run's one channel against the bot's reconnect.
 */
export class ChannelPeer {
  private readonly pending = new Map<string, { resolve(ack: AckMessage): void; timer: ReturnType<typeof setTimeout> }>();
  private reportHandler: ((report: ReportMessage) => void) | undefined;
  private readonly closeHandlers: Array<() => void> = [];
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private answered = true;
  private closed = false;

  /**
   * @param ws - The container's socket, after the handshake the scheduler authenticated.
   * @param ackTimeoutMs - How long {@link ChannelPeer.command} waits for an acknowledgement.
   * @param heartbeatMs - How often the socket is pinged.
   */
  constructor(private readonly ws: WebSocket, private readonly ackTimeoutMs = ACK_TIMEOUT_MS, heartbeatMs = HEARTBEAT_MS) {
    ws.on('message', (raw) => this.receive(raw));
    ws.on('close', () => this.ended());
    ws.on('error', () => undefined); // a socket error is followed by its close, which ends the peer
    ws.on('pong', () => {
      this.answered = true;
    });
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** Sends the run's job: the channel's first message, and again on every channel a reconnecting bot opens. */
  sendJob(job: JobMessage): void {
    this.ws.send(JSON.stringify(job));
  }

  /**
   * Sends a command and resolves with the container's acknowledgement. No acknowledgement within the timeout, or a
   * channel that closes first, resolves with `ok: false`; it never rejects.
   */
  command(command: CommandMessage): Promise<AckMessage> {
    if (this.closed) return Promise.resolve({ type: 'ack', id: command.id, ok: false, error: 'the channel is closed' });
    return new Promise<AckMessage>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolve({ type: 'ack', id: command.id, ok: false, error: `no acknowledgement within ${this.ackTimeoutMs} ms` });
      }, this.ackTimeoutMs);
      timer.unref?.();
      this.pending.set(command.id, { resolve, timer });
      this.ws.send(JSON.stringify(command));
    });
  }

  /** Sets the handler each of the container's reports goes to. */
  onReport(handler: (report: ReportMessage) => void): void {
    this.reportHandler = handler;
  }

  /** Adds a handler called once when the channel closes, whichever side closed it. */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** Closes the channel with a WebSocket close code and a reason. */
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  private ping(): void {
    if (!this.answered) {
      this.ws.terminate(); // the close that follows ends the peer
      return;
    }
    this.answered = false;
    try {
      this.ws.ping();
    } catch {
      this.ws.terminate();
    }
  }

  private receive(raw: RawData): void {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const parsed = ChannelMessage.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ack') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id);
      waiting.resolve(message);
      return;
    }
    if (message.type === 'report') this.reportHandler?.(message);
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve({ type: 'ack', id, ok: false, error: 'the channel closed' });
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
  }
}
