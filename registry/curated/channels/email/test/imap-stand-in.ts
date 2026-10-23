/**
 * @fileoverview A stand-in for an IMAP account behind imapflow's `ImapFlow`, for the specs that read mail and change a
 * mailbox. Its INBOX holds messages under UIDs that need not follow their sequence numbers, as a mailbox's do once a
 * message has been removed (RFC 3501 section 2.3.1.1), and it answers as a server does: SEARCH by a substring of a
 * header field, of the subject, of the body or of the From, ignoring case (section 6.4.4), received on or after a day,
 * and by a UID set, answering UIDs when asked for them; and FETCH of a sequence set, or of a UID set when asked with
 * `{ uid: true }`, with what the query asks and nothing else: the envelope, the flags, the header block or only the
 * fields named (`HEADER.FIELDS`), the source, the body structure, and body parts, each cut to a byte range when asked
 * (section 6.4.5), and, before the answers, a FETCH response of its own for each flag another session changed (section
 * 7.4.2). In a UID set `*` is the largest UID in use, and a range names the numbers between its two ends in
 * either order, so `13:*` names the last message when 12 is the largest UID (section 9). It stands in for imapflow too:
 * a search date imapflow cannot read is left out of the search, as imapflow 1.2.9 leaves it out (`processDateField` in
 * `lib/search-compiler.js`); a `since` given as a `Date` to an account with the WITHIN capability (RFC 5032) matches from
 * that moment, as imapflow then sends it as YOUNGER and the seconds since it, where text, or a `Date` elsewhere, matches
 * from its day; it gives each message's Gmail id as `emailId` while the account offers X-GM-EXT-1, as imapflow asks for
 * X-GM-MSGID then; a command a server would answer BAD rejects as imapflow does; and STORE, COPY, MOVE and the expunge
 * answer as imapflow 1.2.9's `lib/commands/store.js`, `copy.js`, `move.js` and `expunge.js` do: a flag the mailbox does
 * not keep is dropped, labels need X-GM-EXT-1, a refused command answers `false`, MOVE on an account without the
 * extension copies and then deletes whether or not the copy was made, and the expunge after a delete is `UID EXPUNGE` of
 * the UIDs named only when asked by UID on an account with UIDPLUS, else `EXPUNGE`, which removes every message marked
 * deleted.
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
    to?: EnvelopeAddress[];
    cc?: EnvelopeAddress[];
    inReplyTo?: string;
    /**
     * The Date field as imapflow reads it: a `Date`, or the field's text when it does not read as one (imapflow 1.2.9
     * `parseEnvelope` in `lib/tools.js`). The stand-in also takes it as the day the message was received.
     */
    date?: Date | string;
  };
  /** Its flags, such as `\Seen`; none when not given. */
  flags?: string[];
  /** Its Gmail labels, which STORE changes while the account offers X-GM-EXT-1. */
  labels?: string[];
  /** Its Gmail message id (X-GM-MSGID), given as `emailId` while the account offers X-GM-EXT-1. */
  gmailId?: string;
}

/** One command that changed a message: its name as sent, the folder it ran in, the set it named and what it carried. */
export interface Command {
  command: string;
  folder: string;
  set: string;
  detail?: string;
}

/** The account: the messages its INBOX holds, in sequence order, every search it was asked, and every fetch. */
export interface Account {
  inbox: Held[];
  searches: unknown[];
  /** Each fetch's set, whether it named UIDs, its query and its folder, kept when a spec gives the account this list. */
  fetches?: Array<{ set: number[] | string; uid: boolean; query?: FetchQuery; folder?: string }>;
  /** The capabilities the server announces beyond IMAP4rev1, such as `WITHIN`; none when not given. */
  capabilities?: string[];
  /** The account's other folders by path, each holding its messages in sequence order. */
  folders?: Record<string, Held[]>;
  /** Each command that changed a message, in order, kept when a spec gives the account this list. */
  commands?: Command[];
  /** The UIDVALIDITY every folder answers with; 1 when not given. */
  uidValidity?: number;
  /** The flags a folder keeps (PERMANENTFLAGS); any flag when not given. */
  permanentFlags?: string[];
  /**
   * The flags another session sets while a fetch runs, each with its message's UID: the server sends each as a FETCH
   * response of its own during the fetch (RFC 3501 section 7.4.2), which imapflow 1.2.9 yields before the answers,
   * carrying the sequence number, the UID and the flags alone.
   */
  unsolicited?: Array<{ uid: number; flags: string[] }>;
}

/** A search's terms as `EmailService` builds them. */
interface Terms {
  header?: Record<string, string>;
  or?: Array<{ subject?: string; body?: string; from?: string }>;
  since?: unknown;
  uid?: string;
}

/** A body part a fetch asks for: its section, alone or with the byte range to give. */
type BodyPart = string | { key: string; start?: number; maxLength?: number };

/** What a fetch asks for, by imapflow's names. */
export interface FetchQuery {
  uid?: boolean;
  envelope?: boolean;
  flags?: boolean;
  headers?: boolean | string[];
  source?: boolean;
  bodyStructure?: boolean;
  bodyParts?: BodyPart[];
}

/** A node of a body structure, as imapflow 1.2.9 `parseBodystructure` in `lib/tools.js` gives it. */
export interface Structure {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: Structure[];
}

/** A header block's fields, unfolded: each name, in lowercase, with its value after the colon. */
function fieldsOf(header: string): Array<[string, string]> {
  return header
    .replace(/\r\n(?=[ \t])/g, '')
    .split('\r\n')
    .filter((line) => line.includes(':'))
    .map((line) => [line.slice(0, line.indexOf(':')).trim().toLowerCase(), line.slice(line.indexOf(':') + 1)]);
}

/** The text after the colon of every field named `name` in a header block, unfolded. */
function fieldTexts(header: string, name: string): string[] {
  return fieldsOf(header)
    .filter(([field]) => field === name.toLowerCase())
    .map(([, value]) => value);
}

/** A field such as Content-Type read as its value, in lowercase, and its parameters, each value unquoted. */
function parsedField(header: string, name: string): { value: string; params: Record<string, string> } | undefined {
  const text = fieldTexts(header, name)[0];
  if (text === undefined) return undefined;
  const [value = '', ...rest] = text.split(';');
  const params: Record<string, string> = {};
  for (const param of rest) {
    const equals = param.indexOf('=');
    if (equals < 0) continue;
    params[param.slice(0, equals).trim().toLowerCase()] = param
      .slice(equals + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { value: value.trim().toLowerCase(), params };
}

/** A part's header block and its body, split at the blank line that ends the block. */
function headerAndBody(raw: string): [string, string] {
  if (raw.startsWith('\r\n')) return ['', raw.slice(2)];
  const end = raw.indexOf('\r\n\r\n');
  return end < 0 ? [raw, ''] : [raw.slice(0, end + 2), raw.slice(end + 4)];
}

/**
 * The parts of a multipart body, each as sent between two boundary lines, the CRLF before a boundary line counted as
 * the boundary's (RFC 2046 section 5.1.1).
 */
function partsOf(body: string, boundary: string): string[] {
  const parts: string[] = [];
  let current: string[] | undefined;
  for (const line of body.split('\r\n')) {
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (current !== undefined) parts.push(current.join('\r\n'));
      if (line.endsWith('--')) return parts;
      current = [];
      continue;
    }
    current?.push(line);
  }
  return parts;
}

/** The body structure of a message or part, numbered from `path` as imapflow numbers it. */
export function structureOf(header: string, body: string, path: number[] = []): Structure {
  const contentType = parsedField(header, 'content-type') ?? { value: 'text/plain', params: { charset: 'us-ascii' } };
  const node: Structure = { type: contentType.value };
  if (path.length > 0) node.part = path.join('.');
  if (Object.keys(contentType.params).length > 0) node.parameters = contentType.params;
  if (node.type.startsWith('multipart/')) {
    node.childNodes = partsOf(body, contentType.params.boundary ?? '').map((raw, index) => {
      const [partHeader, partBody] = headerAndBody(raw);
      return structureOf(partHeader, partBody, [...path, index + 1]);
    });
    return node;
  }
  node.encoding = (fieldTexts(header, 'content-transfer-encoding')[0] ?? '7bit').trim().toLowerCase();
  node.size = Buffer.byteLength(body);
  const disposition = parsedField(header, 'content-disposition');
  if (disposition !== undefined) {
    node.disposition = disposition.value;
    if (Object.keys(disposition.params).length > 0) node.dispositionParameters = disposition.params;
  }
  if (node.type === 'message/rfc822') {
    // imapflow gives the message inside as a child numbered from the same path.
    const [innerHeader, innerBody] = headerAndBody(body);
    node.childNodes = [structureOf(innerHeader, innerBody, path)];
  }
  return node;
}

/** The body of the part a section such as `2` or `1.2` names (RFC 3501 section 6.4.5), or `undefined` when none. */
function sectionOf(header: string, body: string, section: string): string | undefined {
  const steps = section.split('.').map(Number);
  let [partHeader, partBody] = [header, body];
  for (const [index, step] of steps.entries()) {
    const contentType = parsedField(partHeader, 'content-type');
    if (contentType?.value.startsWith('multipart/') === true) {
      const raw = partsOf(partBody, contentType.params.boundary ?? '')[step - 1];
      if (raw === undefined) return undefined;
      [partHeader, partBody] = headerAndBody(raw);
    } else if (!(index === 0 && step === 1 && steps.length === 1)) {
      // A message that is not multipart has a part 1 alone: its body.
      return undefined;
    }
  }
  return partBody;
}

/** Only the fields `names` names, each as sent with its folds, then the blank line, as `HEADER.FIELDS` answers. */
function onlyFields(header: string, names: string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const kept: string[] = [];
  let keeping = false;
  for (const line of header.split('\r\n')) {
    if (line === '') break;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (keeping) kept.push(line);
      continue;
    }
    keeping = wanted.has(line.slice(0, line.indexOf(':')).trim().toLowerCase());
    if (keeping) kept.push(line);
  }
  return `${kept.map((line) => `${line}\r\n`).join('')}\r\n`;
}

/** The addresses a field such as To lists, in order, each with the name before it when it has one. */
function addressesOf(text: string | undefined): EnvelopeAddress[] | undefined {
  if (text === undefined) return undefined;
  const pieces: string[] = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const character of text) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '<') angled = true;
    if (!quoted && character === '>') angled = false;
    if (character === ',' && !quoted && !angled) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  pieces.push(current);
  const addresses = pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => {
      const angle = /<([^<>]*)>/.exec(piece);
      const name = angle === null ? '' : piece.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1');
      return { ...(name === '' ? {} : { name }), address: angle === null ? piece : (angle[1] ?? '') };
    });
  return addresses.length > 0 ? addresses : undefined;
}

/**
 * A message the account holds under `uid`, from its source as sent (CRLF line ends): its header block, its body, and the
 * envelope a server reads from the header, with a Reply-To of the From when the header has none.
 */
export function storedMessage(uid: number, source: string, extra: Pick<Held, 'flags' | 'labels' | 'gmailId'> = {}): Held {
  const end = source.indexOf('\r\n\r\n');
  const header = end < 0 ? `${source}\r\n\r\n` : source.slice(0, end + 4);
  const body = end < 0 ? '' : source.slice(end + 4);
  const first = (name: string): string | undefined => fieldTexts(header, name)[0]?.trim();
  const from = addressesOf(first('from'));
  const dateText = first('date');
  const date = dateText === undefined ? undefined : Number.isNaN(new Date(dateText).getTime()) ? dateText : new Date(dateText);
  return {
    uid,
    header,
    body,
    envelope: {
      messageId: first('message-id'),
      subject: first('subject'),
      from,
      replyTo: addressesOf(first('reply-to')) ?? from,
      to: addressesOf(first('to')),
      cc: addressesOf(first('cc')),
      inReplyTo: first('in-reply-to'),
      date,
    },
    ...extra,
  };
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

/** A server's BAD answer to a command, as imapflow rejects with it. */
function bad(text: string): Error {
  return Object.assign(new Error('Command failed'), { responseStatus: 'BAD', responseText: text });
}

/** A server's NO answer to a command, as imapflow rejects with it. */
function no(text: string): Error {
  return Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: text });
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

/** A flag as imapflow 1.2.9 `formatFlag` writes it: a system flag in its own case, `\Recent` dropped. */
function formatFlag(flag: string): string | false {
  const lowercase = flag.toLowerCase();
  if (lowercase === '\\recent') return false;
  if (['\\seen', '\\answered', '\\flagged', '\\deleted', '\\draft'].includes(lowercase)) {
    return lowercase.replace(/^\\./, (start) => start.toUpperCase());
  }
  return flag;
}

/** `current` after a STORE that sets, adds or removes `flags`. */
function stored(current: string[], flags: string[], operation: 'set' | 'add' | 'remove'): string[] {
  if (operation === 'set') return [...flags];
  if (operation === 'add') return [...current, ...flags.filter((flag) => !current.includes(flag))];
  return current.filter((flag) => !flags.includes(flag));
}

/** The class a spec gives `vi.mock('imapflow')`: each instance reads `account` at each call. */
export function imapFlowOver(account: Account) {
  /** The messages a folder holds, INBOX in any case, or `undefined` when the account has no such folder. */
  const folderOf = (path: string): Held[] | undefined => (path.toUpperCase() === 'INBOX' ? account.inbox : account.folders?.[path]);
  const offers = (name: string): boolean => (account.capabilities ?? []).includes(name);

  return class {
    /** The folder the connection selected; INBOX until a lock names another. */
    selected = 'INBOX';

    get capabilities(): Map<string, boolean> {
      return new Map((account.capabilities ?? []).map((name) => [name, true]));
    }

    get mailbox(): { path: string; exists: number; uidValidity: bigint; permanentFlags?: Set<string> } {
      return {
        path: this.selected,
        exists: this.messages().length,
        uidValidity: BigInt(account.uidValidity ?? 1),
        ...(account.permanentFlags === undefined ? {} : { permanentFlags: new Set(account.permanentFlags) }),
      };
    }

    async connect(): Promise<void> {}

    async logout(): Promise<void> {}

    async getMailboxLock(path: unknown): Promise<{ path: string; release: () => void }> {
      if (typeof path !== 'string') throw new Error('The stand-in was given a mailbox path that is not text');
      if (folderOf(path) === undefined) throw no('Mailbox does not exist');
      this.selected = path.toUpperCase() === 'INBOX' ? 'INBOX' : path;
      return { path: this.selected, release: () => undefined };
    }

    /** The messages of the selected folder. */
    messages(): Held[] {
      return folderOf(this.selected) ?? [];
    }

    /** The messages of the selected folder a set names, by UID or by sequence number. */
    matching(set: number[] | string, uid: boolean): Held[] {
      const messages = this.messages();
      const largest = uid ? Math.max(0, ...messages.map((message) => message.uid)) : messages.length;
      const ranges = rangesOf(set, largest);
      return messages.filter((message, index) => {
        const n = uid ? message.uid : index + 1;
        return ranges.some(([low, high]) => n >= low && n <= high);
      });
    }

    /** Whether a message answers a search's terms. */
    answers(message: Held, terms: Terms): boolean {
      const capabilities = account.capabilities ?? [];
      const byHeader = Object.entries(terms.header ?? {}).every(([name, part]) => fieldTexts(message.header, name).some((text) => holds(text, part)));
      const byAny =
        terms.or === undefined ||
        terms.or.some(
          (term) =>
            (term.subject !== undefined && holds(message.envelope.subject ?? '', term.subject)) ||
            (term.body !== undefined && holds(message.body, term.body)) ||
            (term.from !== undefined && fieldTexts(message.header, 'from').some((text) => holds(text, term.from ?? ''))),
        );
      // SINCE matches a message received on the day named or later, its time disregarded (RFC 3501 section 6.4.4). imapflow
      // 1.2.9 sends a `Date` to a server with WITHIN as YOUNGER and the seconds since that moment instead, which matches a
      // message received at that moment or later, to the second (RFC 5032 section 2). A message whose Date field is not a
      // date counts as received at the epoch.
      const day = sinceDay(terms.since);
      const received = message.envelope.date instanceof Date ? message.envelope.date : new Date(0);
      const byMoment = capabilities.includes('WITHIN') && terms.since instanceof Date;
      const bySince =
        day === undefined || (byMoment ? received.getTime() >= (terms.since as Date).getTime() : received.toISOString().slice(0, 10) >= day);
      const byUid = terms.uid === undefined || this.matching(terms.uid, true).includes(message);
      return byHeader && byAny && bySince && byUid;
    }

    async search(terms: Terms, options?: { uid?: boolean }): Promise<number[]> {
      account.searches.push(terms);
      const messages = this.messages();
      return messages.flatMap((message, index) => (this.answers(message, terms) ? [options?.uid === true ? message.uid : index + 1] : []));
    }

    async *fetch(set: number[] | string, query: FetchQuery = {}, options?: { uid?: boolean }) {
      const uid = options?.uid === true;
      account.fetches?.push({ set, uid, query, folder: this.selected });
      const messages = this.messages();
      const largest = uid ? Math.max(0, ...messages.map((message) => message.uid)) : messages.length;
      const ranges = rangesOf(set, largest);
      // A server should answer BAD to a sequence number above the messages held, "*" in an empty mailbox among them
      // (RFC 3501 section 9, `seq-number`); a UID that no message has is passed over.
      if (!uid && ranges.some(([, high]) => high > messages.length || high < 1)) throw bad('Invalid messageset');
      // A flag another session changed comes as a FETCH of its own, whatever the set named (lib/commands/fetch.js hands
      // every FETCH response during the command to the fetch's loop).
      for (const change of account.unsolicited ?? []) {
        const index = messages.findIndex((message) => message.uid === change.uid);
        if (index >= 0) yield { seq: index + 1, uid: change.uid, flags: new Set(change.flags) };
      }
      for (const [index, message] of messages.entries()) {
        const n = uid ? message.uid : index + 1;
        if (!ranges.some(([low, high]) => n >= low && n <= high)) continue;
        const answer: Record<string, unknown> = { seq: index + 1, uid: message.uid };
        if (offers('X-GM-EXT-1') && message.gmailId !== undefined) answer.emailId = message.gmailId;
        if (query.envelope === true) answer.envelope = message.envelope;
        if (query.flags === true) answer.flags = new Set(message.flags ?? []);
        if (query.headers !== undefined && query.headers !== false) {
          answer.headers = Buffer.from(Array.isArray(query.headers) ? onlyFields(message.header, query.headers) : message.header);
        }
        if (query.source === true) answer.source = Buffer.from(`${message.header}${message.body}`);
        if (query.bodyStructure === true) answer.bodyStructure = structureOf(message.header, message.body);
        if (query.bodyParts !== undefined) {
          const parts = new Map<string, Buffer>();
          for (const asked of query.bodyParts) {
            const { key, start = 0, maxLength } = typeof asked === 'string' ? { key: asked } : asked;
            const section = sectionOf(message.header, message.body, key);
            if (section === undefined) continue;
            const bytes = Buffer.from(section);
            parts.set(key.toLowerCase(), bytes.subarray(start, maxLength === undefined ? undefined : start + maxLength));
          }
          answer.bodyParts = parts;
        }
        yield answer;
      }
    }

    /** A STORE as imapflow 1.2.9 sends it, answering `false` where imapflow does. */
    store(set: number[] | string, flags: string[], options: { uid?: boolean; useLabels?: boolean }, operation: 'set' | 'add' | 'remove'): boolean {
      if (options.useLabels === true && !offers('X-GM-EXT-1')) return false;
      const permanent = account.permanentFlags;
      const kept = flags
        .map(formatFlag)
        .filter((flag): flag is string => flag !== false && (permanent === undefined || permanent.includes('\\*') || permanent.includes(flag)));
      if (kept.length === 0 && operation !== 'set') return false;
      const uid = options.uid === true;
      for (const message of this.matching(set, uid)) {
        if (options.useLabels === true) message.labels = stored(message.labels ?? [], kept, operation);
        else message.flags = stored(message.flags ?? [], kept, operation);
      }
      const sign = operation === 'add' ? '+' : operation === 'remove' ? '-' : '';
      account.commands?.push({
        command: uid ? 'UID STORE' : 'STORE',
        folder: this.selected,
        set: String(set),
        detail: `${sign}${options.useLabels === true ? 'X-GM-LABELS' : 'FLAGS'} (${kept.join(' ')})`,
      });
      return true;
    }

    async messageFlagsAdd(set: number[] | string, flags: string[], options: { uid?: boolean; useLabels?: boolean } = {}): Promise<boolean> {
      return this.store(set, flags, options, 'add');
    }

    async messageFlagsSet(set: number[] | string, flags: string[], options: { uid?: boolean; useLabels?: boolean } = {}): Promise<boolean> {
      return this.store(set, flags, options, 'set');
    }

    async messageFlagsRemove(set: number[] | string, flags: string[], options: { uid?: boolean; useLabels?: boolean } = {}): Promise<boolean> {
      return this.store(set, flags, options, 'remove');
    }

    async messageCopy(set: number[] | string, destination: string, options: { uid?: boolean } = {}): Promise<{ path: string; destination: string } | false> {
      const uid = options.uid === true;
      const target = folderOf(destination);
      account.commands?.push({ command: uid ? 'UID COPY' : 'COPY', folder: this.selected, set: String(set), detail: destination });
      // A server answers NO [TRYCREATE] to a COPY into a folder that does not exist; imapflow answers it as false.
      if (target === undefined) return false;
      for (const message of this.matching(set, uid)) {
        const next = Math.max(0, ...target.map((held) => held.uid)) + 1;
        target.push({ ...message, uid: next, flags: [...(message.flags ?? [])] });
      }
      return { path: this.selected, destination };
    }

    async messageMove(set: number[] | string, destination: string, options: { uid?: boolean } = {}): Promise<{ path: string; destination: string } | false> {
      if (!offers('MOVE')) {
        // imapflow 1.2.9 `lib/commands/move.js`: COPY, then the delete, whatever the copy answered.
        const copied = await this.messageCopy(set, destination, options);
        await this.messageDelete(set, options);
        return copied;
      }
      const uid = options.uid === true;
      const target = folderOf(destination);
      account.commands?.push({ command: uid ? 'UID MOVE' : 'MOVE', folder: this.selected, set: String(set), detail: destination });
      if (target === undefined) return false;
      const moving = this.matching(set, uid);
      for (const message of moving) {
        const next = Math.max(0, ...target.map((held) => held.uid)) + 1;
        target.push({ ...message, uid: next });
      }
      const source = this.messages();
      for (const message of moving) source.splice(source.indexOf(message), 1);
      return { path: this.selected, destination };
    }

    async messageDelete(set: number[] | string, options: { uid?: boolean } = {}): Promise<boolean> {
      // imapflow 1.2.9 `lib/commands/expunge.js`: mark the messages deleted, then UID EXPUNGE of the set when asked by UID
      // on an account with UIDPLUS (RFC 4315), else EXPUNGE, which removes every message of the folder marked deleted.
      await this.messageFlagsAdd(set, ['\\Deleted'], options);
      const byUid = options.uid === true && offers('UIDPLUS');
      account.commands?.push({ command: byUid ? 'UID EXPUNGE' : 'EXPUNGE', folder: this.selected, set: byUid ? String(set) : '' });
      const named = byUid ? this.matching(set, true) : this.messages();
      const source = this.messages();
      for (const message of named.filter((held) => (held.flags ?? []).includes('\\Deleted'))) source.splice(source.indexOf(message), 1);
      return true;
    }
  };
}
