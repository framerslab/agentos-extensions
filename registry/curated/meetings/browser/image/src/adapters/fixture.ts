import { googleMeetAdapter } from './google-meet.js';
import { microsoftTeamsAdapter } from './microsoft-teams.js';
import type { PlatformAdapter } from './types.js';

/**
 * The test fixture's adapter: the adapter of the platform the link's `platform` query parameter names (the parameter
 * the scheduler read when it took the link from its test allowlist), its own code driven against the fixture page,
 * whose markup carries that platform's selectors, so a lifecycle test exercises the real adapter. Its network policy
 * admits the fixture's own host alone, over plain http as well as https. The bot uses it only for a job the scheduler
 * marked `adapter: 'fixture'`, which no production job carries.
 */
export function fixtureAdapter(meetingUrl: string): PlatformAdapter {
  const url = new URL(meetingUrl);
  const adapter = url.searchParams.get('platform') === 'microsoft_teams' ? microsoftTeamsAdapter : googleMeetAdapter;
  return { ...adapter, joinHosts: [url.hostname], allowedHosts: [url.hostname], allowHttp: true };
}
