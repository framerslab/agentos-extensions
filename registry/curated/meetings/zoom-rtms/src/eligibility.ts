/**
 * Who may start a stream, checked before a host reserves anything: the meeting's host, an alternative host or an
 * invitee, in a meeting that has started. A meeting the person's token cannot read (another account's) is left to
 * Zoom's own start, which refuses a participant who is not on the invitation list; `refusalOfStart` names what each of
 * the start's refusals means.
 *
 * @module
 */
import { ZoomApiError, type ZoomApi, type ZoomMeeting } from './api.js';

/** The check's answer: the person's role in a started meeting, or why they may not start a stream (the meeting has not started, or they are not its host, an alternative host or an invitee). */
export type ZoomEligibility = { ok: true; role: 'host' | 'alternative_host' | 'invitee' | 'unknown' } | { ok: false; reason: 'not_started' | 'not_invited' };

/** Checks the person's place in the meeting with their own token. Throws `ZoomApiError` for a refused token (401) and a fault of the moment. */
export async function checkZoomEligibility(api: ZoomApi, token: string, meetingNumber: string): Promise<ZoomEligibility> {
  const user = await api.me(token);
  let meeting: ZoomMeeting;
  try {
    meeting = await api.meeting(token, meetingNumber);
  } catch (error) {
    if (error instanceof ZoomApiError && (error.status === 400 || error.status === 403 || error.status === 404)) return { ok: true, role: 'unknown' };
    throw error;
  }
  const email = user.email.toLowerCase();
  let role: 'host' | 'alternative_host' | 'invitee' | undefined;
  if (meeting.hostId === user.id) role = 'host';
  else if (meeting.alternativeHosts.some((entry) => entry === user.id || entry.toLowerCase() === email)) role = 'alternative_host';
  else if (meeting.invitees.some((entry) => entry.toLowerCase() === email)) role = 'invitee';
  if (role === undefined) return { ok: false, reason: 'not_invited' };
  if (meeting.status !== 'started') return { ok: false, reason: 'not_started' };
  return { ok: true, role };
}

/** Why Zoom will never start this stream, as a code word a host turns into a sentence. */
export const ZOOM_START_REFUSALS = ['not_allowed', 'rtms_off', 'app_not_allowed', 'not_supported', 'not_found', 'not_started', 'not_connected', 'no_credits'] as const;
/** A refusal a start's error stands for, named by a code word from {@link ZOOM_START_REFUSALS}. */
export type ZoomStartRefusal = (typeof ZOOM_START_REFUSALS)[number];

/** The refusal a start's error stands for, or undefined for a fault of the moment (a rate limit, a server error, a code this list does not know on a 400). */
export function refusalOfStart(error: ZoomApiError): ZoomStartRefusal | undefined {
  switch (error.code) {
    case 2308: // not the host, an alternative host or an invitee
    case 2309:
    case 2312: // the user does not exist
      return 'not_allowed';
    case 13267: // "Share realtime meeting content with apps" is off
      return 'rtms_off';
    case 13262: // the app is not among "Allow apps to access meeting content"
      return 'app_not_allowed';
    case 13273: // the meeting does not support the feature
      return 'not_supported';
    case 3001:
    case 300:
      return 'not_found';
    case 3000:
      return 'not_started';
    case 2310: // the app's own account: no Developer Pack credits
      return 'no_credits';
    default:
      break;
  }
  if (error.status === 401) return 'not_connected';
  if (error.status === 403) return 'not_allowed';
  if (error.status === 404) return 'not_found';
  return undefined;
}
