// Accept DNS domains and dot-atom or quoted local parts. Search uses a smaller alphabet than header parsing.
const domainName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const dotAtom = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const quotedLocal = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])+"$/;
const phrase = /^(?:"(?:\\.|[^"\\])*"|[^"<>@,:;])*$/u;
const namedMailbox = /^((?:"(?:\\.|[^"\\])*"|[^"<>@,:;])*)<(.+)>$/u;
const controls = /[\x00-\x08\x0a-\x1f\x7f]/;

function address(value: string): string | null {
  if (value.length > 254 || controls.test(value) || value.includes('\t')) return null;
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  if (at < 1 || at > 64 || !domainName.test(value.slice(at + 1))) return null;
  const atom = dotAtom.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
  return atom || quotedLocal.test(local) ? value.toLowerCase() : null;
}

/** Accepts a plain address with only characters safe in Gmail query terms. */
export function searchMailboxAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 254 || /\s/.test(value)
    || !/^[a-z0-9_][a-z0-9._+-]*@[a-z0-9.-]+$/i.test(value)) return null;
  return address(value);
}

interface Mailbox { readonly address: string; readonly name: string }
type DecodeHeader = (value: string) => string | null;

function mailbox(value: string, decode: DecodeHeader): Mailbox | null {
  const named = namedMailbox.exec(value);
  const mail = address(decode((named?.[2] ?? value).trim()) ?? '');
  if (mail === null) return null;
  const display = (named?.[1] ?? '').replace(/"((?:\\.|[^"\\])*)"/g, (_, quoted: string) => quoted.replace(/\\(.)/g, '$1'));
  return { address: mail, name: decode(display)?.trim() ?? '' };
}

/** Reads a bounded address list, decoding words only after separating addresses, display names and comments. */
export function headerMailboxes(input: string, decode: DecodeHeader, allowGroups = false): Mailbox[] | null {
  if (input.length > 8192) return null;
  const value = input.replace(/\r\n(?=[ \t])/g, '').trim();
  if (controls.test(value)) return null;
  if (value === '') return [];

  const result: Mailbox[] = [];
  let token = ''; let quoted = false; let comment = 0; let angle = false;
  let group = false; let groupEnded = false;
  const take = (allowEmpty: boolean): boolean => {
    const item = token.trim();
    token = '';
    if (!item) return allowEmpty;
    const parsed = mailbox(item, decode);
    if (parsed === null) return false;
    result.push(parsed);
    return true;
  };

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\' && (quoted || comment > 0)) {
      if (i + 1 === value.length) return null;
      if (quoted) token += value.slice(i, i + 2);
      i++;
      continue;
    }
    if (comment > 0) {
      if (char === '(') comment++;
      if (char === ')') comment--;
      continue;
    }
    if (!quoted && !angle && char === '(') { comment++; token += ' '; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '<') {
        if (angle) return null;
        angle = true;
      } else if (char === '>') {
        if (!angle) return null;
        angle = false;
      } else if (!angle && char === ',') {
        if (!take(groupEnded)) return null;
        groupEnded = false;
        continue;
      } else if (!angle && char === ':') {
        if (!allowGroups || group || groupEnded || !token.trim() || !phrase.test(token.trim())) return null;
        token = '';
        group = true;
        continue;
      } else if (!angle && char === ';') {
        if (!group || !take(true)) return null;
        group = false;
        groupEnded = true;
        continue;
      }
    }
    if (groupEnded && char.trim()) return null;
    token += char;
  }
  return quoted || comment > 0 || angle || group || !take(groupEnded) ? null : result;
}
