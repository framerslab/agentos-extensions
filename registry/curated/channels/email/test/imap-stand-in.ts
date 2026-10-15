/**
 * @fileoverview A stand-in for an IMAP account behind imapflow's `ImapFlow`, for the specs that read mail. Its INBOX
 * holds messages under UIDs that need not follow their sequence numbers, as a mailbox's do once a message has been
 * removed (RFC 3501 section 2.3.1.1), and it answers as a server does: SEARCH by a substring of a header field, of the
 * subject, of the body or of the From, ignoring case (section 6.4.4), and received on or after a day, answering UIDs
 * when asked for them; and FETCH of a sequence set, or of a UID set when asked with `{ uid: true }`, with the envelope,
 * the header block and the source. It stands in for imapflow too: a search date imapflow cannot read is left out of the
 * search, as imapflow 1.2.9 leaves it out (`processDateField` in `lib/search-compiler.js`), and a command a server would
 * answer BAD rejects as imapflow does.
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
    /**
     * The Date field as imapflow reads it: a `Date`, or the field's text when it does not read as one (imapflow 1.2.9
     * `parseEnvelope` in `lib/tools.js`). The stand-in also takes it as the day the message was received.
     */
    date?: Date | string;
  };
}

/** The account: the messages its INBOX holds, in sequence order, every search it was asked, and every fetch. */
export interface Account {
  inbox: Held[];
  searches: unknown[];
  /** Each fetch's set and whether it named UIDs, kept when a spec gives the account this list. */
  fetches?: Array<{ set: number[] | string; uid: boolean }>;
}

/** A search's terms as `EmailService` builds them. */
interface Terms {
  header?: Record<string, string>;
  or?: Array<{ subject?: string; body?: string; from?: string }>;
  since?: unknown;
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

/**
 * The day a search's `since` names, as imapflow sends it: a `Date`, or text it reads as one, by its day in UTC. `undefined`
 * for anything else, an invalid `Date` among them, which imapflow leaves out of the search in silence.
 */
function sinceDay(since: unknown): string | undefined {
  const date = typeof since === 'string' ? new Date(since) : since;
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
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
  // SINCE matches a message received on the day named or later, its time disregarded (RFC 3501 section 6.4.4). A
  // message whose Date field is not a date counts as received at the epoch.
  const day = sinceDay(terms.since);
  const received = message.envelope.date instanceof Date ? message.envelope.date : new Date(0);
  const bySince = day === undefined || received.toISOString().slice(0, 10) >= day;
  return byHeader && byAny && bySince;
}

/** A server's BAD answer to a command, as imapflow rejects with it. */
function bad(text: string): Error {
  return Object.assign(new Error('Command failed'), { responseStatus: 'BAD', responseText: text });
}

/**
 * The ranges a sequence set names, each by its low and high ends (RFC 3501 section 9, `sequence-set`): a list of
 * numbers as imapflow takes one, or text such as `4:*` or `2,4:7`. `*` is `largest`, the largest number in use, and a
 * range holds the numbers between its two ends in either order. Text that is not a sequence set is answered BAD.
 */
function rangesOf(set: number[] | string, largest: number): Array<[number, number]> {
  const parts = Array.isArray(set) ? set.map(String) : set.split(',');
  return parts.map((part) => {
    const ends = part.split(':');
    if (ends.length > 2 || !ends.every((end) => /^(\*|[1-9][0-9]*)$/.test(end))) throw bad('Invalid sequence set');
    const [first, last] = ends.map((end) => (end === '*' ? largest : Number(end)));
    const second = last ?? first ?? 0;
    return [Math.min(first ?? 0, second), Math.max(first ?? 0, second)];
  });
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

    async *fetch(set: number[] | string, _query: unknown, options?: { uid?: boolean }) {
      const uid = options?.uid === true;
      account.fetches?.push({ set, uid });
      const largest = uid ? Math.max(0, ...account.inbox.map((message) => message.uid)) : account.inbox.length;
      const ranges = rangesOf(set, largest);
      // A server should answer BAD to a sequence number above the messages held, "*" in an empty mailbox among them
      // (RFC 3501 section 9, `seq-number`); a UID that no message has is passed over.
      if (!uid && ranges.some(([, high]) => high > account.inbox.length || high < 1)) throw bad('Invalid messageset');
      for (const [index, message] of account.inbox.entries()) {
        const n = uid ? message.uid : index + 1;
        if (!ranges.some(([low, high]) => n >= low && n <= high)) continue;
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
