import { googleMeetAdapter } from './google-meet.js';
import type { PlatformAdapter } from './types.js';

/**
 * The test fixture's adapter: the Google Meet adapter's own code, driven against the fixture page, whose markup carries
 * the Meet selectors, so a lifecycle test exercises the real adapter. Its platform is the one the link's `platform`
 * query parameter names (the parameter the scheduler read when it took the link from its test allowlist), and its
 * network policy admits the fixture's own host alone, over plain http as well as https. The bot uses it only for a job
 * the scheduler marked `adapter: 'fixture'`, which no production job carries.
 */
export function fixtureAdapter(meetingUrl: string): PlatformAdapter {
  const url = new URL(meetingUrl);
  const platform = url.searchParams.get('platform') === 'microsoft_teams' ? 'microsoft_teams' : 'google_meet';
  return { ...googleMeetAdapter, platform, joinHosts: [url.hostname], allowedHosts: [url.hostname], allowHttp: true };
}
