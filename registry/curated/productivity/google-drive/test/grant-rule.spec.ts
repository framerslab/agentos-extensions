import { describe, expect, it } from 'vitest';
import type { OAuthTokenSet } from '@framers/agentos/auth';
import { DRIVE_FILE_SCOPE, DRIVE_GRANT, GoogleOAuthFault, GoogleOAuthFlow, grantHoldsDriveFile, grantMatches, type GoogleGrantRule } from '../src/index.js';

/** A plainly fake web client. */
const CLIENT = { clientId: 'fake-client-id.example.test', clientSecret: 'fake-client-secret' };
/** Where the person comes back to. */
const REDIRECT = 'https://app.example.test/google/callback';
/** A grant's tokens with a scope string. */
const tokens = (scope?: string): OAuthTokenSet => ({ accessToken: 'a', expiresAt: Date.now() + 60_000, refreshToken: 'r', metadata: scope === undefined ? undefined : { scope } });
/** A rule asking exactly a calendar scope with OpenID's two. */
const EXACT: GoogleGrantRule = { providerId: 'google_fixture', scopes: ['https://www.googleapis.com/auth/fixture.readonly', 'openid', 'email'], match: 'exact', extraParams: { access_type: 'offline', prompt: 'consent' } };

describe('the grant rule', () => {
  it("keeps Drive's rule the default: its provider id, its scope held, its address", () => {
    const flow = new GoogleOAuthFlow(CLIENT, null);
    expect(flow.providerId).toBe('google_drive');
    expect(DRIVE_GRANT.scopes).toEqual([DRIVE_FILE_SCOPE]);
    const url = new URL(flow.beginDrive(REDIRECT).url);
    expect(url.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(grantHoldsDriveFile(tokens(`openid ${DRIVE_FILE_SCOPE}`))).toBe(true);
  });

  it("matches `holds` by inclusion and `exact` by the set, reading OpenID's short names as Google's long ones", () => {
    expect(grantMatches(tokens(`openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE_SCOPE}`), DRIVE_GRANT)).toBe(true);
    expect(grantMatches(tokens('https://www.googleapis.com/auth/fixture.readonly openid email'), EXACT)).toBe(true);
    expect(grantMatches(tokens('https://www.googleapis.com/auth/fixture.readonly openid https://www.googleapis.com/auth/userinfo.email'), EXACT)).toBe(true);
    expect(grantMatches(tokens('openid https://www.googleapis.com/auth/userinfo.email email https://www.googleapis.com/auth/fixture.readonly'), EXACT)).toBe(true);
    expect(grantMatches(tokens('https://www.googleapis.com/auth/fixture.readonly openid'), EXACT)).toBe(false);
    expect(grantMatches(tokens(`https://www.googleapis.com/auth/fixture.readonly openid email ${DRIVE_FILE_SCOPE}`), EXACT)).toBe(false);
    expect(grantMatches(tokens(), EXACT)).toBe(false);
  });

  it("asks the rule's scopes and parameters, names its provider, and refuses a begin that asks others", () => {
    const flow = new GoogleOAuthFlow(CLIENT, null, { grant: EXACT });
    expect(flow.providerId).toBe('google_fixture');
    const url = new URL(flow.begin({ redirectUri: REDIRECT }).url);
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/fixture.readonly openid email');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
    expect(() => flow.begin({ redirectUri: REDIRECT, scopes: [DRIVE_FILE_SCOPE] })).toThrow(GoogleOAuthFault);
  });

  it('refuses a malformed rule', () => {
    for (const grant of [{ ...EXACT, providerId: '' }, { ...EXACT, scopes: [] }, { ...EXACT, scopes: ['has space'] }, { ...EXACT, match: 'some' }, { ...EXACT, extraParams: { prompt: 1 } }]) {
      expect(() => new GoogleOAuthFlow(CLIENT, null, { grant: grant as unknown as GoogleGrantRule })).toThrow(GoogleOAuthFault);
    }
  });
});
