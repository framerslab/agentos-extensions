import { readFileSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { outlineOf } from './adapters/chat-outline.js';
import { fixtureAdapter } from './adapters/fixture.js';
import { googleMeetAdapter } from './adapters/google-meet.js';
import { microsoftTeamsAdapter } from './adapters/microsoft-teams.js';
import type { ChatObserver, JoinOutcome, PlatformAdapter } from './adapters/types.js';
import { AudioPublisher } from './audio.js';
import { BotChannel } from './channel.js';
import { chatReport } from './chat-report.js';
import { errorCode, log } from './log.js';
import { installNetworkPolicy } from './network-policy.js';
import type { CommandMessage, JobMessage } from './protocol.js';

const HEARTBEAT_MS = 10_000;
/**
 * How often the bot reports its usage: once a minute from the moment its channel opens until it exits, whatever it is
 * doing. A meeting manager given a usage silence ends a run whose worker sends no usage report for that long as crashed
 * and kills its bot, counting from the dispatch, and a bot that is launching its browser, joining or waiting for its host
 * to admit it reports nothing else.
 */
const USAGE_MS = 60_000;
/** Without a good read of the chat for this long, the bot stops publishing on its own (the manager's clock is the backstop). */
const MONITOR_FAIL_CLOSED_MS = 30_000;
/** The error a bot reports when its identity is signed out: on it the scheduler takes the identity out of the pool. */
const NEEDS_REAUTH = 'needs_reauth';
/** The protocol's ceiling on an error report's message: a longer one would make the scheduler drop the whole report. */
const MAX_MESSAGE = 2000;
/** The farewell after a participant's stop, and after every other leave. */
const FAREWELL_STOPPED = 'Leaving now; everything I took is being deleted.';
const FAREWELL = 'Leaving now.';
/**
 * How long the farewell may take before the bot presses Leave: a bot told to leave is killed thirty seconds after the
 * command, so a farewell the chat is slow to take, or sends again, never keeps the Leave key unpressed past it.
 */
const FAREWELL_MS = 10_000;

/** The run's token: the first line on stdin, which the scheduler writes and then closes. */
function tokenFromStdin(): string {
  const line = readFileSync(0, 'utf8').split('\n')[0]?.trim();
  if (!line) throw new Error('no_token');
  return line;
}

/** Text as a chat panel may show it: spaces collapsed, case folded. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The adapter a job asks for: the fixture's for a job the scheduler took from its test allowlist, else the platform's own. */
function adapterFor(job: JobMessage): PlatformAdapter {
  if (job.adapter === 'fixture') return fixtureAdapter(job.meetingUrl);
  return job.platform === 'google_meet' ? googleMeetAdapter : microsoftTeamsAdapter;
}

async function main(): Promise<void> {
  const channelUrl = process.env.MEETING_CHANNEL_URL;
  if (!channelUrl) throw new Error('no_channel_url');
  const token = tokenFromStdin();
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let adapter: PlatformAdapter | undefined;
  let publisher: AudioPublisher | undefined;
  let job: JobMessage | undefined;
  let observer: ChatObserver | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let usage: ReturnType<typeof setInterval> | undefined;
  let leaving = false;
  let exiting: Promise<never> | undefined;
  let phase = 'channel';
  const blocked = new Map<string, number>();
  /** What the bot posted itself, as the panel may show it: its own words, the notice that names the stop phrase among them, are never chat. */
  const posted: string[] = [];
  const startedAt = Date.now();
  const seconds = (): number => Math.round((Date.now() - startedAt) / 1000);

  const exit = (reason: string, code: number, message?: string): Promise<never> => {
    if (!exiting) {
      exiting = (async (): Promise<never> => {
        if (heartbeat) clearInterval(heartbeat);
        if (usage) clearInterval(usage);
        observer?.stop();
        await publisher?.close().catch((err: unknown) => log.warn('step_failed', { phase: 'exit', reason: 'audio_close', code: errorCode(err) }));
        await context?.close().catch((err: unknown) => log.warn('step_failed', { phase: 'exit', reason: 'browser_close', code: errorCode(err) }));
        if (blocked.size) {
          log.warn('network_blocked', { count: blocked.size });
          const hosts = [...blocked.entries()].map(([h, n]) => `${h}x${n}`).join(',');
          channel.report('error', { message: `network_blocked: ${hosts}`.slice(0, MAX_MESSAGE) }); // hosts and counts, never content
        }
        // the step's code rides on the left report with the reason, so the product writes the run's end and its detail
        // from one event; the outline stays on the error report before it
        channel.report('left', { reason, seconds: seconds(), ...(message === undefined ? {} : { message }) });
        // the end the scheduler would report for this exit: done on a clean one, crashed with the code on any other
        channel.report(code === 0 ? 'done' : 'crashed', code === 0 ? { seconds: seconds() } : { seconds: seconds(), message: `exit ${code}` });
        log.info('exiting', { phase, reason, exitCode: code });
        await new Promise((r) => setTimeout(r, 300));
        channel.close();
        process.exit(code);
      })();
    }
    return exiting;
  };

  const say = async (text: string): Promise<void> => {
    const own = normalize(text);
    if (!own) throw new Error('empty_chat_text');
    if (!page || !adapter) throw new Error('not_in_call');
    posted.push(own);
    await adapter.postChat(page, text);
  };

  const isOwn = (text: string): boolean => {
    const read = normalize(text);
    return posted.some((own) => read === own || read.includes(own));
  };

  const leave = async (reason: string, farewell: string): Promise<void> => {
    if (leaving || exiting) return;
    leaving = true;
    if (heartbeat) clearInterval(heartbeat);
    observer?.stop();
    await publisher?.suspend().catch((err: unknown) => log.warn('step_failed', { phase: 'leave', reason: 'audio_suspend', code: errorCode(err) }));
    if (page && adapter) {
      // the farewell for FAREWELL_MS at most, then Leave, whether the chat took the farewell or not
      let timer: ReturnType<typeof setTimeout> | undefined;
      const said = say(farewell).catch((err: unknown) => log.warn('step_failed', { phase: 'leave', reason: 'farewell', code: errorCode(err) }));
      const timeUp = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn('step_failed', { phase: 'leave', reason: 'farewell', code: 'farewell_timeout' });
          resolve();
        }, FAREWELL_MS);
      });
      await Promise.race([said, timeUp]);
      clearTimeout(timer);
      await adapter.leave(page).catch((err: unknown) => log.warn('step_failed', { phase: 'leave', reason: 'leave_key', code: errorCode(err) }));
    }
    await exit(reason, 0);
  };

  const onCommand = async (command: CommandMessage): Promise<void> => {
    if (!job) throw new Error('no_job');
    switch (command.name) {
      case 'startCapture': {
        // the bot's own interlock under the manager's: never while it leaves, never before the notice's chat is read,
        // and never on a read of the chat older than the fail-closed limit
        if (leaving || exiting) throw new Error('leaving');
        const good = observer?.lastGoodPollAt();
        if (!publisher || good === undefined || Date.now() - good > MONITOR_FAIL_CLOSED_MS) throw new Error('monitor_not_healthy');
        await publisher.start();
        channel.report('capture_started');
        log.info('capture_started');
        return;
      }
      case 'suspendCapture':
        await publisher?.suspend();
        channel.report('capture_suspended');
        log.info('capture_suspended', { reason: 'command' });
        return;
      case 'postChat':
        if (leaving || exiting) throw new Error('leaving');
        await say(command.text ?? '');
        return;
      case 'leave':
        void leave(command.reason ?? 'ended', command.reason === 'stopped_by_participant' ? FAREWELL_STOPPED : FAREWELL);
        return;
      case 'kill':
        log.warn('exiting', { reason: 'kill', exitCode: 137 });
        process.exit(137);
    }
  };

  const channel = new BotChannel(channelUrl, token, onCommand);

  const reauth = async (): Promise<never> => {
    log.warn('failed', { phase, code: NEEDS_REAUTH });
    channel.report('error', { message: NEEDS_REAUTH });
    return exit('crashed', 3);
  };

  log.info('started');
  job = await channel.connect();
  // the usage, at once and then once a minute, in the waiting room and the join as much as in the call: the reports keep
  // a manager's usage silence from ending a run whose host has not admitted its bot yet
  const reportUsage = (): void => channel.report('usage', { seconds: seconds() });
  reportUsage();
  usage = setInterval(reportUsage, USAGE_MS);
  adapter = adapterFor(job);
  publisher = new AudioPublisher(job.livekit);
  const totalTimer = setTimeout(() => void leave('cap', FAREWELL), job.limits.totalMs);
  totalTimer.unref();
  try {
    phase = 'livekit';
    await publisher.connect();
    phase = 'browser';
    const args = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-dev-shm-usage', '--window-size=1280,720'];
    context = await chromium.launchPersistentContext(job.profileDir ?? '/tmp/profile', {
      headless: false,
      args,
      viewport: { width: 1280, height: 720 },
      permissions: ['microphone'],
      // a service worker's own requests pass Playwright's routing by: with none registered, every request meets the policy
      serviceWorkers: 'block',
      // Chromium's own sandbox needs user namespaces, which the container's dropped capabilities and seccomp profile
      // refuse; the container is the boundary: no capabilities, a read-only root, the seccomp profile, the worker's egress
      chromiumSandbox: false,
    });
    await installNetworkPolicy(context, adapter, blocked);
    // a browser or a page that dies under the bot ends the run at once: the bot is no longer in the call
    const gone = (code: string): void => {
      if (leaving || exiting) return; // the bot's own leave ends the run, and its exit closes the browser
      log.error('failed', { phase, code });
      channel.report('error', { message: `${phase}: ${code}` });
      void exit('crashed', 1);
    };
    context.on('close', () => gone('browser_closed'));
    page = context.pages()[0] ?? (await context.newPage());
    page.on('crash', () => gone('page_crashed'));
    phase = 'join';
    channel.report('joining');
    let joined: JoinOutcome;
    try {
      joined = await adapter.join(page, { meetingUrl: job.meetingUrl, botName: job.botName, signedIn: job.profileDir !== undefined });
    } catch (err) {
      if (errorCode(err) === NEEDS_REAUTH) return await reauth();
      throw err;
    }
    if (job.profileDir !== undefined && (await adapter.needsReauth(page))) return await reauth();
    if (joined.state === 'waiting_room') {
      phase = 'waiting_room';
      channel.report('waiting_room');
      try {
        await adapter.waitForCall(page, job.limits.waitingRoomMs);
      } catch {
        return await exit('not_admitted', 0);
      }
    }
    phase = 'notice';
    const count = await adapter.participantCount(page);
    channel.report('in_call', { participantCount: count });
    try {
      await say(job.notice.text);
    } catch (err) {
      log.warn('failed', { phase, code: errorCode(err) });
      // the step's code, and after it the chat panel's outline when the step left one (frames, counts of controls by
      // role, the controls' names, the lookups tried: never a message, a name or a link), so the next failure explains itself
      channel.report('error', { message: `notice: ${errorCode(err)}${outlineOf(err)}`.slice(0, MAX_MESSAGE) });
      return await exit('notice_failed', 0, `notice: ${errorCode(err)}`);
    }
    channel.report('notice_posted');
    phase = 'chat';
    const stopPhrase = job.stopPhrase;
    try {
      observer = await adapter.observeChat(page, (message) => {
        if (leaving || isOwn(message.text)) return;
        const report = chatReport(message, stopPhrase);
        channel.report('chat_message', { text: report.text, sender: report.sender });
        // the phrase alone: another bot's notice in the chat names the phrase too, and is a chat message like any other
        if (report.stop) {
          channel.report('stop_command', { sender: report.sender });
          void leave('stopped_by_participant', FAREWELL_STOPPED);
        }
      });
    } catch {
      log.warn('failed', { phase, code: 'chat_unreadable' });
      channel.report('error', { message: 'the chat could not be read after the notice' });
      return await exit('stop_monitor_failed', 0);
    }
    channel.report('monitor_heartbeat'); // the observer's first read, just done: the fact the manager's interlock waits for
    phase = 'call';
    let lastCount = count;
    let aloneSince: number | undefined;
    let ticking = false;
    heartbeat = setInterval(() => {
      if (ticking || leaving) return; // one tick at a time: a slow read never overlaps the next
      ticking = true;
      void (async () => {
        const good = observer!.lastGoodPollAt();
        const now = Date.now();
        if (good !== undefined && now - good <= HEARTBEAT_MS) {
          channel.report('monitor_heartbeat'); // only a read of the chat within the last ten seconds is a heartbeat
        } else if (good === undefined || now - good > MONITOR_FAIL_CLOSED_MS) {
          if (publisher!.isPublishing) {
            await publisher!.suspend(); // fail closed: nothing leaves the call while its stop command cannot be read
            channel.report('capture_suspended');
            log.warn('capture_suspended', { reason: 'monitor_stale' });
          }
        }
        // a count the client does not show is unknown, never zero: it starts no alone timer and is not reported
        const n = await adapter!.participantCount(page!);
        if (n !== undefined) {
          if (lastCount !== undefined && n !== lastCount) channel.report(n > lastCount ? 'participant_joined' : 'participant_left', { participantCount: n });
          lastCount = n;
          if (n === 0) {
            aloneSince ??= Date.now();
            if (Date.now() - aloneSince > job!.limits.aloneMs) void leave('alone', FAREWELL);
          } else aloneSince = undefined;
        }
      })()
        .catch((err: unknown) => log.warn('step_failed', { phase: 'call', reason: 'tick', code: errorCode(err) }))
        .finally(() => {
          ticking = false;
        });
    }, HEARTBEAT_MS);
    // from here the manager's startCapture is what starts the audio: nothing is published until it arrives
  } catch (err) {
    if (leaving || exiting) return; // a step cut short by the bot's own leave or exit is no failure of its own
    const code = errorCode(err);
    log.error('failed', { phase, code });
    // the step's code, and after it the page's outline when the step left one (a join's: hosts, the client's own names
    // and fixed words, never a word the page shows), so the next failure explains itself
    channel.report('error', { message: `${phase}: ${code}${outlineOf(err)}`.slice(0, MAX_MESSAGE) });
    await exit('crashed', 1);
  }
}

void main().catch((err: unknown) => {
  log.error('failed', { phase: 'start', code: errorCode(err) });
  process.exit(1);
});
