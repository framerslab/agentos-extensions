/**
 * @fileoverview A Slack message as the read keeps it, parsed from a Web API answer or an event: its timestamp, its
 * thread, its writer, its text, its last edit and its files' names, never a file. Messages that only notice a change to
 * the channel (a join, a topic) are not kept; a person's message, a file share, a bot's or an app's post, a thread reply
 * sent to the channel too and a `/me` message are.
 * @module agentos-ext-slack-source/messages
 */
import { compareSlackTs, slackTsMs } from './types.js';

/** The longest message text kept, in characters: Slack's own limit on a message's text. */
export const SLACK_MESSAGE_CHARACTERS = 40_000;

/** The most file names kept for one message. */
const maxFiles = 20;

/** The message subtypes a document keeps: none (a person's message), and these. */
const keptSubtypes: ReadonlySet<string> = new Set(['file_share', 'bot_message', 'thread_broadcast', 'me_message']);

/** One message as the read keeps it. */
export interface SlackMessage {
  /** Slack's timestamp, the message's id within its channel. */
  readonly ts: string;
  /** The parent's timestamp for a thread reply; null for a message in the channel, a thread's parent included. */
  readonly threadTs: string | null;
  /** The writer's user id; null for a bot's or an app's post without one. */
  readonly user: string | null;
  /** The posting bot's id, for a bot's or an app's post. */
  readonly botId: string | null;
  /** The posting bot's or app's name, as Slack gives it with the post. */
  readonly botName: string | null;
  /** Slack's subtype; null for a person's message. */
  readonly subtype: string | null;
  /** The text as Slack stores it, mentions and links in its markup, at most 40,000 characters. */
  readonly text: string;
  /** The timestamp of the last edit, or null for a message never edited. */
  readonly editedTs: string | null;
  /** The names of the files shared with it, never the files. */
  readonly files: readonly string[];
  /** The replies its thread holds, for a thread's parent; zero otherwise. */
  readonly replyCount: number;
}

/**
 * A field of an object, or undefined.
 *
 * @param value - The object.
 * @param key - The field.
 * @returns The field's value.
 */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * A string field of at most `maximum` characters, or null.
 *
 * @param value - The field's value.
 * @param maximum - The longest string kept.
 * @returns The string, or null.
 */
function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

/**
 * Whether a message's subtype is one a document keeps.
 *
 * @param subtype - The subtype, or null for a person's message.
 * @returns True for a kept subtype.
 */
export function isKeptSubtype(subtype: string | null): boolean {
  return subtype === null || keptSubtypes.has(subtype);
}

/**
 * Parses one message object of a Web API answer or an event. A message whose timestamp is malformed answers null, as
 * does one whose subtype only notices a change to the channel.
 *
 * @param value - The message object.
 * @returns The message, or null.
 */
export function parseSlackMessage(value: unknown): SlackMessage | null {
  const ts = field(value, 'ts');
  if (typeof ts !== 'string' || slackTsMs(ts) === null) return null;
  const subtype = text(field(value, 'subtype'), 64);
  if (!isKeptSubtype(subtype)) return null;
  const thread = field(value, 'thread_ts');
  const threadTs = typeof thread === 'string' && slackTsMs(thread) !== null && thread !== ts ? thread : null;
  const user = text(field(value, 'user'), 64);
  const botId = text(field(value, 'bot_id'), 64);
  const botName = text(field(value, 'username'), 256) ?? text(field(field(value, 'bot_profile'), 'name'), 256);
  const body = field(value, 'text');
  const edited = field(field(value, 'edited'), 'ts');
  const files: string[] = [];
  const list = field(value, 'files');
  if (Array.isArray(list)) {
    for (const file of list.slice(0, maxFiles)) {
      const name = text(field(file, 'name'), 512) ?? text(field(file, 'title'), 512);
      if (name !== null) files.push(name);
    }
  }
  const replies = field(value, 'reply_count');
  return Object.freeze({
    ts, threadTs, user, botId, botName, subtype,
    text: typeof body === 'string' ? body.slice(0, SLACK_MESSAGE_CHARACTERS) : '',
    editedTs: typeof edited === 'string' && slackTsMs(edited) !== null ? edited : null,
    files: Object.freeze(files),
    replyCount: typeof replies === 'number' && Number.isSafeInteger(replies) && replies > 0 ? replies : 0,
  });
}

/**
 * A message's version: its last edit's timestamp, or its own timestamp when never edited. A later version of the same
 * message replaces an earlier one; an earlier one never replaces a later one.
 *
 * @param message - The message.
 * @returns The version.
 */
export function slackMessageVersion(message: SlackMessage): string {
  return message.editedTs !== null && compareSlackTs(message.editedTs, message.ts) > 0 ? message.editedTs : message.ts;
}

/**
 * The user ids a set of messages names: their writers and the people their text mentions.
 *
 * @param messages - The messages.
 * @returns The ids, each once, in the order first named.
 */
export function slackPeopleOf(messages: Iterable<SlackMessage>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.user !== null) ids.add(message.user);
    for (const match of message.text.matchAll(/<@([UW][A-Z0-9]{2,31})(?:\|[^>]*)?>/g)) ids.add(match[1]!);
  }
  return [...ids];
}

