/**
 * @fileoverview A stand-in for an IMAP account behind imapflow's `ImapFlow`, for the specs that read mail. Its INBOX
 * holds messages under UIDs that need not follow their sequence numbers, as a mailbox's do once a message has been
 * removed (RFC 3501 section 2.3.1.1), and it answers as a server does: SEARCH by a substring of a header field, of the
 * subject, of the body or of the From, ignoring case (section 6.4.4), answering UIDs when asked for them; and FETCH of a
 * sequence set, or of a UID set when asked with `{ uid: true }`, with the envelope, the header block and the source.
 */

/** An address as imapflow's envelope gives it. */
export interface EnvelopeAddress {
  name?: string;
  address?: string;
}

/** One message the stand-in holds. */
export interface Held {
  /** Its UID. */
  uid: number;
  /** Its header block as sent: one field a line, folds kept, CRLF line ends, and the blank line that ends it. */
  header: string;
  /** Its body. */
  body: string;
  /** The envelope a server reads from the header, decoded (RFC 3501 section 7.4.2). */
  envelope: {
    messageId?: string;
    subject?: string;
    from?: EnvelopeAddress[];
    /** The Reply-To, which a server fills with the From when the header has none. */
    replyTo?: EnvelopeAddress[];
    inReplyTo?: string;
    date?: Date;
  };
}

/** The account: the messages its INBOX holds, in sequence order, and every search it was asked. */
export interface Account {
  inbox: Held[];
  searches: unknown[];
}

/** A search's terms as `EmailService` builds them. */
interface Terms {
  header?: Record<string, string>;
  or?: Array<{ subject?: string; body?: string; from?: string }>;
  since?: Date;
}

/** The text after the colon of every field named `name` in a header block, unfolded. */
function fieldTexts(header: string, name: string): string[] {
  return header
    .replace(/\r\n(?=[ \t])/g, '')
    .split('\r\n')
    .filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map((line) => line.slice(name.length + 1));
}

/** Whether `text` holds `part`, ignoring case. */
function holds(text: string, part: string): boolean {
  return text.toLowerCase().includes(part.toLowerCase());
}

/** Whether a message answers a search's terms. */
function answers(message: Held, terms: Terms): boolean {
  const byHeader = Object.entries(terms.header ?? {}).every(([name, part]) => fieldTexts(message.header, name).some((text) => holds(text, part)));
  const byAny =
    terms.or === undefined ||
    terms.or.some(
      (term) =>
        (term.subject !== undefined && holds(message.envelope.subject ?? '', term.subject)) ||
        (term.body !== undefined && holds(message.body, term.body)) ||
        (term.from !== undefined && fieldTexts(message.header, 'from').some((text) => holds(text, term.from ?? ''))),
    );
  const bySince = terms.since === undefined || (message.envelope.date ?? new Date(0)) >= terms.since;
  return byHeader && byAny && bySince;
}

/** Whether a range, as a list of numbers or as `first:last` with `*` for the end, holds `n`. */
function inRange(range: number[] | string, n: number): boolean {
  if (Array.isArray(range)) return range.includes(n);
  const [first = '', last = first] = range.split(':');
  return n >= Number(first) && (last === '*' || n <= Number(last));
}

/** The class a spec gives `vi.mock('imapflow')`: each instance reads `account` at each call. */
export function imapFlowOver(account: Account) {
  return class {
    get mailbox(): { exists: number } {
      return { exists: account.inbox.length };
    }

    async connect(): Promise<void> {}

    async logout(): Promise<void> {}

    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => undefined };
    }

    async search(terms: Terms, options?: { uid?: boolean }): Promise<number[]> {
      account.searches.push(terms);
      return account.inbox.flatMap((message, index) => (answers(message, terms) ? [options?.uid === true ? message.uid : index + 1] : []));
    }

    async *fetch(range: number[] | string, _query: unknown, options?: { uid?: boolean }) {
      for (const [index, message] of account.inbox.entries()) {
        if (!inRange(range, options?.uid === true ? message.uid : index + 1)) continue;
        yield {
          seq: index + 1,
          uid: message.uid,
          envelope: message.envelope,
          headers: Buffer.from(message.header),
          source: Buffer.from(`${message.header}${message.body}`),
          flags: new Set<string>(),
        };
      }
    }
  };
}
