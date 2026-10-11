# Google Calendar

This pack gives an agent event listing, creation, updates, deletion, calendar discovery and free time queries through the Google Calendar API using `googleapis` and OAuth2.

## Installation

```bash
npm install @framers/agentos-ext-calendar-google
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

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

## Notes

The package requires Node.js `>=22`. Missing required OAuth credentials make the factory throw, even when `accessToken` is provided. Activation initializes the OAuth client; service operations require initialization. The pack also registers `googleCalendarService` with kind `productivity`.

Event creation, updates and deletion change the selected calendar. Creation and updates send `start` and `end` as `dateTime` fields. The update tool applies `timeZone` only alongside a supplied `start` or `end`. Attendees are accepted by the create tool; the update tool has no attendee parameter.

Event listing defaults to `primary`, orders events by start time and caps `maxResults` at `250`. Free time search defaults absent or empty `calendarIds` to `primary`, merges overlapping busy intervals and returns entire gaps meeting the minimum duration. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
