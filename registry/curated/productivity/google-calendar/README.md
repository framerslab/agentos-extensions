# Google Calendar

This pack gives an agent event listing, creation, updates, deletion, calendar discovery and free time queries through the Google Calendar API using `googleapis` and OAuth2. On its `./reader` subpath it gives a host that keeps its own grant a typed read surface on `fetch`: the windowed read, the incremental read, the read by id, the event's shape and the meeting link's candidates. The same subpath carries the flow that makes that grant, `GoogleCalendarOAuthFlow`: one read-only events scope with `openid` and `email`, held exactly at the exchange and at every refresh.

## Installation

```bash
npm install @framers/agentos-ext-calendar-google @framers/agentos @framers/agentos-ext-account-sources
```

Peer dependencies, as `package.json` declares them: `@framers/agentos` `>=0.13.144` and `@framers/agentos-ext-account-sources` `>=0.7.3`. The grant on `./reader` runs on the Drive pack's flow (`@framers/agentos-ext-google-drive`, a dependency of this pack), which loads both, so `./reader` needs both installed, even in a host that uses its reads alone. The package is an ES module: import it; a CommonJS `require()` of it is not supported.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-calendar-google',
        options: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `clientId` | `google.clientId` | `GOOGLE_CLIENT_ID` | Yes | No default |
| `clientSecret` | `google.clientSecret` | `GOOGLE_CLIENT_SECRET` | Yes | No default |
| `refreshToken` | `google.refreshToken` | `GOOGLE_REFRESH_TOKEN`, then `GOOGLE_CALENDAR_REFRESH_TOKEN` | Yes | No default |
| `accessToken` | | | No | No token |
| `priority` | | | No | `50` |
| `secrets` | | | No | No map |
| Context `logger` | | | No | No logger |

Nonempty credential options precede `options.secrets`, followed by environment fallbacks in the order shown. `accessToken` is read directly from options. The logger receives activation and deactivation messages.

## Tools

| Tool | What it does |
| --- | --- |
| `calendarListEvents` | Lists events in a time range with summaries, times, locations and attendees. |
| `calendarCreateEvent` | Creates an event with times, description, location and attendees. |
| `calendarUpdateEvent` | Updates the supplied fields of an existing event. |
| `calendarDeleteEvent` | Deletes an event by ID. |
| `calendarFindFreeTime` | Queries calendar availability and returns open slots meeting the requested duration. |
| `calendarListCalendars` | Lists accessible calendars with IDs, names and time zones. |

### `calendarListEvents`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendarId` | string | No | Calendar ID to query (defaults to "primary") |
| `timeMin` | string | No | Start of time range in ISO 8601 format (e.g. "2025-01-15T09:00:00Z") |
| `timeMax` | string | No | End of time range in ISO 8601 format (e.g. "2025-01-15T17:00:00Z") |
| `maxResults` | number | No | Maximum number of events to return (default 10, max 250) |

### `calendarCreateEvent`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendarId` | string | No | Calendar ID to create the event in (defaults to "primary") |
| `summary` | string | Yes | Event title/summary |
| `start` | string | Yes | Start datetime in ISO 8601 format (e.g. "2025-01-15T09:00:00-05:00") |
| `end` | string | Yes | End datetime in ISO 8601 format (e.g. "2025-01-15T10:00:00-05:00") |
| `description` | string | No | Event description or notes |
| `location` | string | No | Event location (address or place name) |
| `attendees` | array of strings | No | Array of attendee email addresses |
| `timeZone` | string | No | IANA time zone (e.g. "America/New_York"). Applied to start/end if not embedded. |

### `calendarUpdateEvent`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendarId` | string | No | Calendar ID containing the event (defaults to "primary") |
| `eventId` | string | Yes | ID of the event to update |
| `summary` | string | No | Updated event title/summary |
| `start` | string | No | Updated start datetime in ISO 8601 format |
| `end` | string | No | Updated end datetime in ISO 8601 format |
| `description` | string | No | Updated event description |
| `location` | string | No | Updated event location |
| `timeZone` | string | No | IANA time zone for start/end (e.g. "America/New_York") |

### `calendarDeleteEvent`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendarId` | string | No | Calendar ID containing the event (defaults to "primary") |
| `eventId` | string | Yes | ID of the event to delete |

### `calendarFindFreeTime`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `calendarIds` | array of strings | No | Calendar IDs to check (defaults to ["primary"]) |
| `timeMin` | string | Yes | Start of search window in ISO 8601 format |
| `timeMax` | string | Yes | End of search window in ISO 8601 format |
| `durationMinutes` | number | Yes | Minimum duration of free slot in minutes |

### `calendarListCalendars`

The input schema has no parameters.

## Reading with your own grant

`@framers/agentos-ext-calendar-google/reader` reads a calendar with an access token the host supplies, through `fetch`. It loads neither `googleapis` nor the tools above.

```ts
import { GoogleCalendarReader, meetingLinkCandidates } from '@framers/agentos-ext-calendar-google/reader';

const reader = new GoogleCalendarReader({ accessToken: async () => grant.accessToken() });

// The windowed read: every page of the next seven days, and the last page's sync token.
const now = new Date();
const week = await reader.readWindow({
  calendarId: 'primary',
  timeMin: now,
  timeMax: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  pageSize: 250,
  maxPages: 10,
});
for (const event of week.events) {
  console.log(event.id, event.start?.dateTime, meetingLinkCandidates(event));
}

// The incremental read: what changed since the token, whatever its dates; a 410 answers gone.
if (week.complete && week.nextSyncToken !== null) {
  const changes = await reader.readChanges({ calendarId: 'primary', syncToken: week.nextSyncToken, pageSize: 250, maxPages: 10 });
  if (changes.gone) {
    // Google refused the token: clear it and read the window again.
  } else {
    for (const event of changes.events) {
      if (event.status === 'cancelled') console.log('ended', event.id);
    }
  }
}

// One event by its id; a 404 or a 410 answers gone.
const read = await reader.readEvent({ calendarId: 'primary', eventId: 'fixtureevent1' });
```

Every page of `readWindow` and `readChanges` is asked with `singleEvents=true`, and never with `orderBy`, `timeMin` or `timeMax` beside a sync token; `readEvent` sends no query, since Google's `events.get` takes no `singleEvents`. A read cut at `maxPages` answers `complete: false` and no token. `onPage` runs after each page is read, before the next is asked, so a host can renew a lease there.

`mapCalendarEvent(raw)` gives the event's shape: the instance's id and its series' (`recurringEventId`), the status, `start` and `end` as an instant with its zone or an all-day date, `originalStartTime` for a moved or cancelled instance, `organizerSelf`, the `guests` with their `self`, `resource` and `organizer` flags and their `answer`, `guestsOmitted`, the conference's `video` entry point with its solution, `location`, `description`, `summary` and `updated`. A video entry point whose address does not parse as HTTPS with a host reads null. A cancelled instance of a series carries its id, its series' id and its original start and no times; a deleted event its id alone; every other field reads null or empty. A body with no id maps to `null`.

`meetingLinkCandidates(event)` answers the addresses the meeting may be joined at, in order: the conference's video entry point alone when it has one; otherwise the Meet and Teams addresses the location names, then those the description names, each once. An address holds printable ASCII alone: it ends at a blank, a control character, a quote, a bracket or any character past ASCII, such as a curly quote, an ideographic comma or an emoji, which neither service writes in its addresses. The stops that close a sentence (`.`, `,`, `;`, `:`, `!` and `?`) are dropped from its end. The location and the description are read as HTML writes them: a character reference reads as the character it names. A character an address holds stays in it, so `&#63;`, `&#x3F;` and `&quest;` read as `?`, and `&amp;`, `&#38;` and `&#x26;` as `&`. A reference to a blank, a control character, a quote or a bracket, such as `&nbsp;`, `&quot;` or `&lt;`, ends an address as that character would, and so do a named reference to any other character and a number that names no character; an address written right after such a reference is read as the next. `hangoutLink` is never read. A host keeps the first candidate its own bot provider accepts.

A failure is a `CalendarReadFault` whose `reason` is a fixed word, with Google's text never carried; its message is `calendar_read_<reason>`:

| Reason | When |
| --- | --- |
| `refused` | A 401, or a 403 that names no rate or quota |
| `limited` | A 429, or a 403 naming a rate or quota (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`) |
| `failed` | Any other answer, a network failure, a body that is not JSON, or a malformed page |
| `timeout` | A call past `deadlineMs` (10,000 by default), from the wait for its token to the last byte of its answer |
| `too_large` | An answer past `maxBytes` (8,388,608 by default) |
| `cancelled` | The caller's `signal` aborted, before the call or while it waited on its token, on Google's answer or on its body |
| `configuration` | A malformed input, bound or address |

The deadline and the signal hold whether or not the token supplier, `fetchImpl` or the answer's body heeds them: a token that comes after a stop is never sent, and an answer that comes after one is let go unread. An error the `accessToken` supplier throws is the host's own, such as a refused grant or a refresh another process holds, and passes through as thrown, never as a `CalendarReadFault`.

`readChanges` answers `{ gone: true }` for a 410, and `readEvent` for a 404 or a 410; neither throws for those.

The `api` option names a stand-in for tests. It is taken only on CI (`CI=true`) at a loopback or `.invalid` host, with no userinfo, query or fragment, over HTTPS or over plain HTTP at a loopback host; any other address throws `configuration`.

## The grant

`GoogleCalendarOAuthFlow`, on the same subpath, is Google's grant for the person's calendar: the Drive pack's `GoogleOAuthFlow` (`@framers/agentos-ext-google-drive`, a dependency of this pack) under the calendar's rule, `calendarGrant`. It asks one read-only events scope, `https://www.googleapis.com/auth/calendar.events.owned.readonly` ("See the events on Google calendars you own.") by default or `https://www.googleapis.com/auth/calendar.events.readonly` ("View events on all your calendars.") as the `scope` option, with `openid` and `email`, offline and with consent, without incremental scopes. A grant counts only when its scopes are exactly that set, at the exchange and at every refresh.

```ts
import { GoogleCalendarOAuthFlow, GoogleCalendarReader } from '@framers/agentos-ext-calendar-google/reader';

const callback = 'https://app.example.com/calendar/google/callback';

// The request that sends the person to Google: keep the state and the verifier until they come back.
const begun = new GoogleCalendarOAuthFlow({ clientId, clientSecret }, null).beginCalendar(callback);

// The request Google sends the person back to. `store` is an IOAuthTokenStore, such as the auth module's
// SealedTokenStore under the connection's namespace.
const flow = new GoogleCalendarOAuthFlow({ clientId, clientSecret }, store);
const tokens = await flow.complete({ code, state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: callback });
const address = tokens.metadata?.email; // the address the grant was made for, read from the ID token; the store never sees it
await flow.keep(connectionId, tokens);

// Later: an access token for the reader, refreshed one at a time a key; and the grant's end.
const reader = new GoogleCalendarReader({ accessToken: () => flow.accessToken(connectionId) });
await flow.forget(connectionId); // revokes the kept refresh token at Google's revocation address and clears the grant
```

`complete` answers the grant with `metadata.email`, the address the ID token of the token endpoint's answer names, lower-cased. `idTokenAccount(idToken, clientId, now)` reads that token's claims and refuses, as `GoogleOAuthFault` `invalid_response`, a token whose issuer is not Google's, whose audience is not the client alone, whose authorized party (`azp`), when present, is another client, whose expiry is not a finite number past now, whose address is unverified or absent, or which is missing or malformed (a second audience and another party are refused by OpenID Connect Core 1.0, section 3.1.3.7, items 3 and 5); the signature is not checked, since a token received from the token endpoint itself is validated by the connection's TLS (OpenID Connect Core 1.0, section 3.1.3.7, item 6). `keep` hands the store the refresh token and the scopes alone, never the address, the access token or the ID token.

A grant missing a scope, holding an extra one or lacking a refresh token is refused at the exchange (`GoogleOAuthFault` `scope` or `refresh_token`); a refresh whose answer names scopes outside the set throws `scope`, and one that names none keeps the kept set. `revoke(token)` posts to Google's revocation address and resolves when Google revokes the token or answers that it is already expired or revoked; any other refusal is the auth module's `OAuthGrantRefused`. The flow's options are the Drive pack's (`fetchImpl`, `signal` and, on CI alone, stand-in `endpoints`) with `scope` in place of `grant`; its faults are the Drive pack's `GoogleOAuthFault`, exported from this subpath too, so a host that installs this pack alone catches them from here. Options that are not an object, such as a fetch given in their place, and a scope other than the two throw `configuration`.

## Notes

The package requires Node.js `>=22`. Missing required OAuth credentials make the factory throw, even when `accessToken` is provided. Activation initializes the OAuth client; service operations require initialization. The pack also registers `googleCalendarService` with kind `productivity`.

Event creation, updates and deletion change the selected calendar. Creation and updates send `start` and `end` as `dateTime` fields. The update tool applies `timeZone` only alongside a supplied `start` or `end`. Attendees are accepted by the create tool; the update tool has no attendee parameter.

Event listing defaults to `primary`, orders events by start time and caps `maxResults` at `250`. Free time search defaults absent or empty `calendarIds` to `primary`, merges overlapping busy intervals and returns entire gaps meeting the minimum duration. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
