/**
 * A Zoom join link, read by its host and path alone: no request is made and no redirect is followed. The provider takes
 * meetings on `zoom.us` and its subdomains; a webinar, a personal link name (which carries no meeting number) and a
 * host's start link (which carries the host's start token) are refused with the reason.
 *
 * @module
 */

/** What a join link names. */
export interface ZoomJoinLink {
  /** The meeting's number as the link carries it: 9 to 13 digits, kept as text. */
  meetingNumber: string;
  /** The link's host, lower-cased. */
  host: string;
}

/** A join link read: what it names, or why it was refused. */
export type ZoomJoinLinkResult = { ok: true; link: ZoomJoinLink } | { ok: false; message: string };

const NUMBER = /^\d{9,13}$/;

/** Reads a join link, or says why it is not one. */
export function parseZoomJoinUrl(url: string): ZoomJoinLinkResult {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, message: 'not a url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, message: 'the link must be https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, message: 'the link carries credentials' };
  if (parsed.port !== '') return { ok: false, message: 'the link names a port' };
  const host = parsed.hostname.toLowerCase();
  if (host !== 'zoom.us' && !host.endsWith('.zoom.us')) return { ok: false, message: 'not a Zoom meeting link' };
  const parts = parsed.pathname.split('/').filter((part) => part !== '');
  if (parts[0] === 'w') return { ok: false, message: 'a webinar link; this provider serves meetings' };
  if (parts[0] === 'my') return { ok: false, message: 'a personal link name; paste the link that carries the meeting number' };
  if (parts[0] === 's') return { ok: false, message: 'a host start link; paste the join link' };
  let candidate: string | undefined;
  if (parts[0] === 'j') candidate = parts[1];
  else if (parts[0] === 'wc' && parts[1] === 'join') candidate = parts[2];
  else if (parts[0] === 'wc' && parts[2] === 'join') candidate = parts[1];
  if (candidate === undefined || !NUMBER.test(candidate)) return { ok: false, message: 'not a Zoom meeting link' };
  return { ok: true, link: { meetingNumber: candidate, host } };
}
