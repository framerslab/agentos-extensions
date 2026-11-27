import { SourceSyncFault } from '@framers/agentos-ext-account-sources';
import type { GmailApi } from './gmail.js';
import { headerMailboxes } from './mailboxAddresses.js';
import { GmailTextFault, sanitizeMailMetadata, type GmailTextPolicy } from './mailSanitize.js';
import { messageText } from './messageText.js';
import {
  decodeMimeWords, GmailMappingFault, mappingActive, mimeAttachments, mimeMessageHeaders, mimeTextBody,
  parseMimePayload, type GmailMappingBounds, type MimeBudget,
} from './mime.js';

/** A continuation of one recipient search. Use it with the same mailbox, recipients and page size. */
export interface GmailMailboxCursor {
  /** The original exclusive lower bound in epoch milliseconds, or null for a search without a time floor. */
  readonly after: number | null;
  /** The bounded opaque Gmail token for the next candidate page. */
  readonly pageToken: string;
}

/** Server-side criteria for one bounded search of an authorized Gmail mailbox. */
export interface GmailMailboxIngestOptions {
  /** One to ten plain mailbox addresses. Comparisons are case-insensitive. */
  readonly recipients: readonly string[];
  /** An exclusive internal date in epoch milliseconds or a continuation from this search. */
  readonly after?: number | GmailMailboxCursor;
  /** Maximum candidates to fetch, 1 to 100 and within the client's message limit. Defaults to 20 or that limit if lower. */
  readonly maxMessages?: number;
  /** Cancels the list and all message reads. */
  readonly signal?: AbortSignal;
}

/** The private server-side projection of one message whose delivery headers match a configured recipient. */
export interface GmailMailboxMessage {
  /** Gmail's message id. */
  readonly messageId: string;
  /** Gmail's thread id. */
  readonly threadId: string;
  /** Gmail's internal date in epoch milliseconds. */
  readonly internalDate: number;
  /** The matched configured mailbox in lower case. */
  readonly matchedRecipient: string;
  /** The lowercased mailbox and sanitized display name from a single valid From mailbox. */
  readonly from: { readonly address: string | null; readonly name: string };
  /** Sanitized, decoded subject. */
  readonly subject: string;
  /** Sanitized body text with recognized reply history and signatures trimmed. */
  readonly text: string;
  /** Bounded list of attachment summaries, in MIME order. */
  readonly attachments: readonly { readonly name: string; readonly size: number }[];
  /** The body was unreadable or exceeded a MIME or transport bound. */
  readonly bodyOmitted: boolean;
}

/** One page of selected messages and its continuation, which is null after the last candidate page. */
export interface GmailMailboxPage {
  /** Selected messages in candidate order. */
  readonly messages: readonly GmailMailboxMessage[];
  /** Continue even after an empty page when this value is present. */
  readonly cursor: GmailMailboxCursor | null;
}

/**
 * Ingests a bounded page of messages addressed to configured mailboxes using a read-only, authorized Gmail client.
 * Delivery headers stay inside the call. The From address is private and should be treated as unverified input.
 *
 * @param api The host's authorized server-side client for the intended mailbox.
 * @param options The recipient list, exclusive time floor or continuation, and optional page size and cancellation.
 * @throws {SourceSyncFault} A fixed error for invalid arguments, a malformed provider response or a failed operation.
 */
export function ingestMailbox<Prepared>(api: GmailApi<Prepared>, options: GmailMailboxIngestOptions): Promise<GmailMailboxPage> {
  return api.ingestMailbox(options);
}

const envelopeFields = ['Delivered-To', 'X-Original-To', 'To', 'Cc', 'List-Id', 'X-Original-Sender', 'From', 'Subject'] as const;
type EnvelopeField = Lowercase<typeof envelopeFields[number]>;

/** The only headers a metadata-only recovery request needs. */
export const mailboxMetadataHeaders: readonly string[] = envelopeFields;

const fieldByName = new Map<string, EnvelopeField>(envelopeFields.map((name) => {
  const key = name.toLowerCase() as EnvelopeField;
  return [key, key];
}));

/** Whether a MIME limit, rather than an invalid provider shape, prevented reading content. */
export function mailboxMimeLimit(error: unknown): boolean {
  return (error instanceof GmailMappingFault && (error.reason === 'response_too_large' || error.reason === 'structure_limit'))
    || (error instanceof GmailTextFault && error.reason === 'input_too_large');
}

interface Candidate {
  readonly id: string;
  readonly threadId: string;
  readonly internalDate: number;
  readonly payload: unknown;
}

type DecodeHeader = (value: string) => string | null;

function groupRecipient(headers: ReadonlyMap<EnvelopeField, readonly string[]>, recipients: ReadonlySet<string>,
  decode: DecodeHeader): string | null {
  const ids = headers.get('list-id');
  const senders = headers.get('x-original-sender');
  if (ids?.length !== 1 || senders?.length !== 1 || headerMailboxes(senders[0]!, decode)?.length !== 1) return null;
  const identity = /^[^<>]*<([^<>\s]+)>$/.exec(ids[0]!.trim())?.[1];
  const listId = identity === undefined ? null : decode(identity)?.toLowerCase();
  if (!listId) return null;
  const matches = [...recipients].filter((recipient) => recipient.replace('@', '.') === listId);
  return matches.length === 1 ? matches[0]! : null;
}

function matchedRecipient(headers: ReadonlyMap<EnvelopeField, readonly string[]>, recipients: ReadonlySet<string>,
  decode: DecodeHeader): string | null {
  const match = (field: EnvelopeField): string | null => {
    for (const value of headers.get(field) ?? []) {
      for (const mailbox of headerMailboxes(value, decode, field === 'to' || field === 'cc') ?? []) {
        if (recipients.has(mailbox.address)) return mailbox.address;
      }
    }
    return null;
  };
  return match('delivered-to') ?? match('x-original-to') ?? groupRecipient(headers, recipients, decode) ?? match('to') ?? match('cc');
}

/** Checks routing from bounded root headers before reading body text and returns only the public projection. */
export async function projectMailboxMessage(
  candidate: Candidate, recipients: ReadonlySet<string>, bounds: GmailMappingBounds, metadataOnly: boolean,
  signal?: AbortSignal,
): Promise<GmailMailboxMessage | null> {
  mappingActive(signal);
  const budget: MimeBudget = { bounds, rawBytes: 0, decodedBytes: 0, parts: 0 };
  const rawHeaders = mimeMessageHeaders(candidate.payload, budget);
  let bodyOmitted = metadataOnly;
  const decode = (input: string): string | null => {
    try { return decodeMimeWords(input, budget); }
    catch (error) {
      if (mailboxMimeLimit(error)) { bodyOmitted = true; return null; }
      if (error instanceof GmailMappingFault && (error.reason === 'invalid_encoding' || error.reason === 'unsupported_charset')) {
        return null;
      }
      throw error;
    }
  };
  const headers = new Map<EnvelopeField, string[]>();
  for (const header of rawHeaders) {
    const field = fieldByName.get(header.name.toLowerCase());
    if (field === undefined) continue;
    const values = headers.get(field) ?? [];
    values.push(header.value);
    headers.set(field, values);
  }
  const matched = matchedRecipient(headers, recipients, decode);
  if (matched === null) return null;

  const policy = (maximum: number): GmailTextPolicy => ({
    maxInputCharacters: bounds.maxInputCharacters,
    maxLineCharacters: bounds.maxLineCharacters,
    maxOutputCharacters: Math.min(maximum, bounds.maxInputCharacters),
  });
  const display = (value: string): string => {
    try { return sanitizeMailMetadata(value, policy(200)).text; }
    catch (error) { if (mailboxMimeLimit(error)) { bodyOmitted = true; return ''; } throw error; }
  };
  const fromValues = headers.get('from');
  const fromList = fromValues?.length === 1 ? headerMailboxes(fromValues[0]!, decode) : null;
  const from = fromList?.length === 1 ? fromList[0]! : null;
  const sender = { address: from?.address ?? null, name: display(from?.name ?? '') };
  const subject = display(decode(headers.get('subject')?.[0] ?? '') ?? '');

  let text = '';
  let attachments: GmailMailboxMessage['attachments'] = [];
  if (!metadataOnly) {
    // The full parser charges the root headers again as part of its own raw-byte budget.
    budget.rawBytes = 0;
    try {
      const payload = parseMimePayload(candidate.payload, budget, signal);
      attachments = mimeAttachments(payload).slice(0, 32).map(({ filename, size }) => ({
        name: display(decode(filename) ?? '') || display('attachment'), size,
      }));
      if (!bodyOmitted) {
        const body = await mimeTextBody(payload, budget, signal);
        text = messageText(body.text, policy(bounds.maxMessageCharacters)).text;
      }
    } catch (error) {
      if (!mailboxMimeLimit(error) && !(error instanceof GmailMappingFault
        && (error.reason === 'invalid_encoding' || error.reason === 'unsupported_charset'))) throw error;
      bodyOmitted = true;
    }
  }

  mappingActive(signal);
  return { messageId: candidate.id, threadId: candidate.threadId, internalDate: candidate.internalDate,
    matchedRecipient: matched, from: sender, subject, text, attachments, bodyOmitted };
}
