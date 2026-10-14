import WebSocket, { type RawData } from 'ws';
import { errorCode, log } from './log.js';
import { ChannelMessage, type AckMessage, type CommandMessage, type JobMessage, type ReportMessage } from './protocol.js';

/** What the bot does with one command; a rejection is acknowledged as a refusal, named by its content-free code. */
export type CommandHandler = (command: CommandMessage) => Promise<void>;

/** How long the bot keeps opening its channel, at its start or after a drop, before it gives the run up. */
const RETRY_FOR_MS = 300_000;

/** One message off the channel, or `undefined` for one that does not parse (the scheduler's end drops those the same way). */
function parse(raw: RawData): ChannelMessage | undefined {
  try {
    const parsed = ChannelMessage.safeParse(JSON.parse(raw.toString()));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The container's end of the command channel: connects with the token, takes the job, acknowledges commands, numbers
 * reports. A channel that drops (the scheduler restarted) is opened again with the same token, with a pause that
 * doubles from one second to thirty, for five minutes, and the first channel is opened the same way; the scheduler
 * sends the job again on each new channel, which the bot ignores once it holds one; reports made while the channel was
 * down are sent when it is back.
 */
export class BotChannel {
  private ws: WebSocket | undefined;
  private seq = 0;
  private job: JobMessage | undefined;
  private closedByBot = false;
  private readonly pendingReports: string[] = [];

  /**
   * @param url - The scheduler's channel url, from `MEETING_CHANNEL_URL`.
   * @param token - The run's token, read from stdin.
   * @param onCommand - What carries out each command; its outcome is the command's acknowledgement.
   */
  constructor(private readonly url: string, private readonly token: string, private readonly onCommand: CommandHandler) {}

  /** Opens the channel and resolves with the job, its first message; rejects with `channel_unreachable` when none opens for five minutes. */
  async connect(): Promise<JobMessage> {
    const job = await this.openWithRetry();
    if (!job) throw new Error('channel_unreachable');
    this.job = job;
    return job;
  }

  private open(): Promise<JobMessage> {
    const ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on('error', () => undefined); // an error is followed by the socket's close, which decides what happens next
    return new Promise<JobMessage>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('close', () => reject(new Error('channel_closed'))); // closed before the job came (a refused token, a restart)
      ws.once('message', (raw) => {
        const first = parse(raw);
        if (first?.type !== 'job') {
          ws.close(1008, 'the first message was not the job');
          return reject(new Error('channel_no_job'));
        }
        ws.on('message', (again) => {
          const next = parse(again);
          if (next?.type !== 'command') return;
          const command = next;
          this.onCommand(command)
            .then(() => this.send({ type: 'ack', id: command.id, ok: true } satisfies AckMessage))
            .catch((err: unknown) => {
              const code = errorCode(err);
              log.warn('command_refused', { reason: command.name, code });
              this.send({ type: 'ack', id: command.id, ok: false, error: code } satisfies AckMessage);
            });
        });
        ws.on('close', () => {
          if (this.ws === ws) this.ws = undefined;
          if (!this.closedByBot) void this.reconnect();
        });
        for (const queued of this.pendingReports.splice(0)) ws.send(queued);
        resolve(first);
      });
    });
  }

  /** Opens a channel, again and again with a doubling pause, until one gives the job or five minutes pass. */
  private async openWithRetry(): Promise<JobMessage | undefined> {
    const deadline = Date.now() + RETRY_FOR_MS;
    let pause = 1_000;
    for (let attempt = 1; !this.closedByBot; attempt += 1) {
      try {
        return await this.open();
      } catch {
        if (Date.now() + pause >= deadline) {
          log.error('channel_given_up', { count: attempt });
          return undefined;
        }
        await new Promise((r) => setTimeout(r, pause));
        pause = Math.min(pause * 2, 30_000);
      }
    }
    return undefined;
  }

  private async reconnect(): Promise<void> {
    log.warn('channel_lost');
    const job = await this.openWithRetry(); // the job sent again is the one the bot holds; nothing changes
    if (!job && !this.closedByBot) {
      process.exit(4); // no scheduler for five minutes: the run cannot be commanded or reported; the exit is what the scheduler will see
    }
  }

  /** Numbers and sends one report; a report made while the channel is down waits for the next channel. */
  report(event: ReportMessage['event'], data?: ReportMessage['data']): void {
    const message: ReportMessage = { type: 'report', seq: ++this.seq, event, at: Date.now(), data };
    this.send(message);
  }

  private send(message: AckMessage | ReportMessage): void {
    const text = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.pendingReports.push(text);
  }

  /** Closes the channel for good: the bot is exiting, and no reconnect follows. */
  close(): void {
    this.closedByBot = true;
    this.ws?.close(1000, 'bot exiting');
  }
}
