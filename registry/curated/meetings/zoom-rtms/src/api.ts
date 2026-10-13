/**
 * The three calls of Zoom's API this provider makes, each with a person's own access token: who the person is, what a
 * meeting says of its host, alternative hosts and invitees, and a participant's stream started or stopped. An error
 * keeps Zoom's status and code and never its words, which carry the user's id.
 *
 * @module
 */
import { z } from 'zod';

/** Zoom's REST API origin and version. */
export const ZOOM_API_BASE_URL = 'https://api.zoom.us/v2';

/** Zoom's API refused a call. */
export class ZoomApiError extends Error {
  constructor(
    readonly status: number,
    /** Zoom's own error code from the answer's body, when it carried one. */
    readonly code: number | undefined,
  ) {
    super(`Zoom's API answered ${status}${code === undefined ? '' : ` with code ${code}`}`);
    this.name = 'ZoomApiError';
  }
}

/** Who a token belongs to, as `GET /users/me` answers it: the user's id, email and account id. */
export interface ZoomUser {
  id: string;
  email: string;
  accountId: string;
}

/** A meeting as `GET /meetings/{meetingId}` answers it, in the fields the eligibility check reads. */
export interface ZoomMeeting {
  /** The meeting's number, as text. */
  id: string;
  uuid: string;
  /** `waiting` or `started`. */
  status: string;
  hostId: string;
  /** Email addresses or user ids, as the meeting's settings list them. */
  alternativeHosts: string[];
  /** The invitees' email addresses. */
  invitees: string[];
}

const UserAnswer = z.object({ id: z.string().min(1), email: z.string().min(1), account_id: z.string().min(1) });

const MeetingAnswer = z.object({
  id: z.union([z.number(), z.string()]),
  uuid: z.string().default(''),
  status: z.string().default(''),
  host_id: z.string().min(1),
  settings: z
    .object({
      alternative_hosts: z.string().optional(),
      meeting_invitees: z.array(z.object({ email: z.string().optional() })).optional(),
    })
    .optional(),
});

/** The three calls this provider makes to Zoom's API, each with a person's own access token; a test can replace the base address and `fetch`. */
export class ZoomApi {
  constructor(private readonly options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {}

  private async call(token: string, method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<Response> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl ?? ZOOM_API_BASE_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    if (response.ok) return response;
    const json = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new ZoomApiError(response.status, typeof json?.code === 'number' ? json.code : undefined);
  }

  /** The person the token belongs to. */
  async me(token: string): Promise<ZoomUser> {
    const answer = UserAnswer.parse(await (await this.call(token, 'GET', '/users/me')).json());
    return { id: answer.id, email: answer.email, accountId: answer.account_id };
  }

  /** A meeting by its number, as far as the token may read it. */
  async meeting(token: string, meetingNumber: string): Promise<ZoomMeeting> {
    const answer = MeetingAnswer.parse(await (await this.call(token, 'GET', `/meetings/${encodeURIComponent(meetingNumber)}`)).json());
    return {
      id: String(answer.id),
      uuid: answer.uuid,
      status: answer.status,
      hostId: answer.host_id,
      alternativeHosts: (answer.settings?.alternative_hosts ?? '')
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter((part) => part !== ''),
      invitees: (answer.settings?.meeting_invitees ?? []).flatMap((invitee) => (invitee.email === undefined || invitee.email === '' ? [] : [invitee.email])),
    };
  }

  /** Starts or stops the app's stream for a participant of a meeting under way. */
  async setRtmsStatus(token: string, meetingNumber: string, action: 'start' | 'stop', settings: { clientId: string; participantUserId: string }): Promise<void> {
    await this.call(token, 'PATCH', `/live_meetings/${encodeURIComponent(meetingNumber)}/rtms_app/status`, {
      action,
      settings: { client_id: settings.clientId, participant_user_id: settings.participantUserId },
    });
  }
}
