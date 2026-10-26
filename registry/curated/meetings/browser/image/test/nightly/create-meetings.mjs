// The nightly real-join check's meetings, made in the team's own tenants: a Google Calendar event with a Meet on the
// host user's calendar, with the bot's identity invited, through the service account's domain-wide delegation; and a
// Microsoft Teams meeting under the app registration, for the organiser user, that lets everyone past its lobby, since
// no person attends it (a bot that the client still holds in the lobby is what the check observes).
//
//   node create-meetings.mjs >> "$GITHUB_OUTPUT"     makes both and prints meet_event_id, meet_url, meet_host,
//                                                     teams_meeting_id and teams_url, each as soon as it is known
//   node create-meetings.mjs remove                   deletes the two named by MEET_EVENT_ID and TEAMS_MEETING_ID
//
// --platform google_meet or --platform microsoft_teams makes, or removes, that platform's meeting alone, so the other
// platform's variables may be absent: the workflow's job for each platform runs it so. Any other argument exits 2.
//
// Each join link is masked in the run's log (::add-mask:: on stderr, which the runner reads for workflow commands while
// stdout goes to the step's outputs). A meeting that cannot be made is reported on stderr and left out of the outputs:
// the join step records that platform as not created and fails the run. Nothing here prints a link, a token or a key.
import { createSign, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MEETING_MINUTES = 60;
const SUBJECT = 'Notetaker nightly check';

const env = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const output = (name, value) => process.stdout.write(`${name}=${value}\n`);
const mask = (value) => process.stderr.write(`::add-mask::${value}\n`);
const note = (line) => process.stderr.write(`${line}\n`);

/** The status and the API's own error code of a refused call, never its body, which can quote what was sent. */
async function refusal(what, res) {
  let code = '';
  try {
    const body = await res.json();
    code = body?.error?.status ?? body?.error?.code ?? (typeof body?.error === 'string' ? body.error : '');
  } catch {
    code = '';
  }
  return new Error(`${what} answered ${res.status}${code ? ` ${String(code).slice(0, 60)}` : ''}`);
}

async function call(what, url, init) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw await refusal(what, res);
  return res;
}

const base64url = (data) => Buffer.from(data).toString('base64url');

/** An access token for the host user's calendar: the service account's RS256 assertion, with the user as its subject. */
async function googleToken() {
  let account;
  try {
    account = JSON.parse(env('MEET_CALENDAR_SA_JSON'));
  } catch {
    // the parser's message quotes the text it read, which is the key
    throw new Error('MEET_CALENDAR_SA_JSON is not a service account key in JSON');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: account.client_email, sub: env('MEET_HOST_USER'), scope: CALENDAR_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }))}`;
  const signature = createSign('SHA256').update(unsigned).sign(account.private_key).toString('base64url');
  const res = await call('the Google token endpoint', GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  return (await res.json()).access_token;
}

/** An application token for Microsoft Graph, by the client credentials grant. */
async function graphToken() {
  const res = await call('the Microsoft token endpoint', `https://login.microsoftonline.com/${encodeURIComponent(env('TEAMS_GRAPH_TENANT_ID'))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('TEAMS_GRAPH_CLIENT_ID'), client_secret: env('TEAMS_GRAPH_CLIENT_SECRET'), scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  return (await res.json()).access_token;
}

const meetLink = (event) => event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;

async function createMeet() {
  const token = await googleToken();
  const auth = { authorization: `Bearer ${token}` };
  const start = new Date();
  const end = new Date(start.getTime() + MEETING_MINUTES * 60_000);
  const res = await call('the Calendar API', `${CALENDAR_EVENTS}?conferenceDataVersion=1&sendUpdates=none`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: SUBJECT,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email: env('MEET_BOT_IDENTITY') }],
      conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }),
  });
  let event = await res.json();
  output('meet_event_id', event.id);
  // the conference may still be in the making when the event comes back: read the event again until it is ready
  for (let i = 0; i < 15 && event.conferenceData?.createRequest?.status?.statusCode === 'pending'; i += 1) {
    await new Promise((r) => setTimeout(r, 2_000));
    event = await (await call('the Calendar API', `${CALENDAR_EVENTS}/${encodeURIComponent(event.id)}`, { headers: auth })).json();
  }
  const status = event.conferenceData?.createRequest?.status?.statusCode;
  const link = meetLink(event);
  if (!link) throw new Error(`the event has no Meet link (conference ${status ?? 'absent'})`);
  mask(link);
  output('meet_url', link);
  // the organiser as Google reports it: the join step refuses a Meet whose organiser is not the host user
  output('meet_host', event.organizer?.email ?? '');
  note('Google Meet: an event with a Meet made on the host user\'s calendar, the bot\'s identity invited');
}

async function createTeams() {
  const token = await graphToken();
  const start = new Date();
  const end = new Date(start.getTime() + MEETING_MINUTES * 60_000);
  const res = await call('Microsoft Graph', `${GRAPH}/users/${encodeURIComponent(env('TEAMS_ORGANIZER_USER_ID'))}/onlineMeetings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: SUBJECT, startDateTime: start.toISOString(), endDateTime: end.toISOString(), lobbyBypassSettings: { scope: 'everyone', isDialInBypassEnabled: false } }),
  });
  const meeting = await res.json();
  output('teams_meeting_id', meeting.id);
  if (!meeting.joinWebUrl) throw new Error('the meeting has no join link');
  mask(meeting.joinWebUrl);
  output('teams_url', meeting.joinWebUrl);
  note('Microsoft Teams: an online meeting made for the organiser user, with everyone let past its lobby');
}

/** Deletes each of the chosen platforms' meetings whose id it is given; exits 1 when one could not be deleted. */
async function removeMeetings(platforms) {
  let failed = 0;
  const eventId = platforms.includes('google_meet') ? process.env.MEET_EVENT_ID?.trim() : undefined;
  if (eventId) {
    try {
      const token = await googleToken();
      const res = await fetch(`${CALENDAR_EVENTS}/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!res.ok && res.status !== 404 && res.status !== 410) throw await refusal('the Calendar API', res);
      note('Google Meet: the event is removed');
    } catch (err) {
      failed += 1;
      note(`Google Meet: the event was not removed: ${err.message}`);
    }
  }
  const meetingId = platforms.includes('microsoft_teams') ? process.env.TEAMS_MEETING_ID?.trim() : undefined;
  if (meetingId) {
    try {
      const token = await graphToken();
      const res = await fetch(`${GRAPH}/users/${encodeURIComponent(env('TEAMS_ORGANIZER_USER_ID'))}/onlineMeetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!res.ok && res.status !== 404) throw await refusal('Microsoft Graph', res);
      note('Microsoft Teams: the meeting is removed');
    } catch (err) {
      failed += 1;
      note(`Microsoft Teams: the meeting was not removed: ${err.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

/** The platforms by the names the scheduler and the outcome give them. */
const PLATFORMS = { google_meet: ['Google Meet', createMeet], microsoft_teams: ['Microsoft Teams', createTeams] };

function usage(problem) {
  note(`${problem}; usage: node create-meetings.mjs [remove] [--platform ${Object.keys(PLATFORMS).join('|')}]`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({ options: { platform: { type: 'string' } }, allowPositionals: true });
} catch (err) {
  usage(err.message);
}
const [mode, ...extra] = args.positionals;
if (extra.length > 0 || (mode !== undefined && mode !== 'remove')) usage(`unexpected arguments: ${args.positionals.join(' ')}`);
const only = args.values.platform;
if (only !== undefined && !Object.hasOwn(PLATFORMS, only)) usage(`there is no platform ${only}`);
const chosen = only === undefined ? Object.keys(PLATFORMS) : [only];

if (mode === 'remove') {
  await removeMeetings(chosen);
} else {
  for (const name of chosen) {
    const [platform, create] = PLATFORMS[name];
    try {
      await create();
    } catch (err) {
      note(`${platform}: no meeting was made: ${err.message}`);
    }
  }
}
