import { describe, it, expect } from 'vitest';
import { ZoomApi, ZoomApiError, type ZoomMeeting, type ZoomUser } from '../src/api.js';
import { checkZoomEligibility, refusalOfStart } from '../src/eligibility.js';

const me: ZoomUser = { id: 'u-1', email: 'USER@Example.test', accountId: 'a-1' };
const meeting = (over: Partial<ZoomMeeting> = {}): ZoomMeeting => ({ id: '81234567890', uuid: 'm', status: 'started', hostId: 'u-9', alternativeHosts: [], invitees: [], ...over });

/** An API whose two reads answer what a test gives. */
function api(read: ZoomMeeting | ZoomApiError, user: ZoomUser | ZoomApiError = me): ZoomApi {
  const fakeApi = new ZoomApi();
  fakeApi.me = async () => {
    if (user instanceof ZoomApiError) throw user;
    return user;
  };
  fakeApi.meeting = async () => {
    if (read instanceof ZoomApiError) throw read;
    return read;
  };
  return fakeApi;
}

describe('checkZoomEligibility', () => {
  it('allows the host, an alternative host by email or id, and an invitee, whatever the case of the email', async () => {
    expect(await checkZoomEligibility(api(meeting({ hostId: 'u-1' })), 't', '81234567890')).toEqual({ ok: true, role: 'host' });
    expect(await checkZoomEligibility(api(meeting({ alternativeHosts: ['user@example.test'] })), 't', '81234567890')).toEqual({ ok: true, role: 'alternative_host' });
    expect(await checkZoomEligibility(api(meeting({ alternativeHosts: ['u-1'] })), 't', '81234567890')).toEqual({ ok: true, role: 'alternative_host' });
    expect(await checkZoomEligibility(api(meeting({ invitees: ['DANA@example.TEST'] })), 't', '81234567890')).toEqual({ ok: true, role: 'invitee' });
  });
  it('refuses a person the meeting does not name, before anything else', async () => {
    expect(await checkZoomEligibility(api(meeting({ invitees: ['sam@example.test'] })), 't', '81234567890')).toEqual({ ok: false, reason: 'not_invited' });
    expect(await checkZoomEligibility(api(meeting({ status: 'waiting' })), 't', '81234567890')).toEqual({ ok: false, reason: 'not_invited' });
  });
  it('refuses a meeting that has not started', async () => {
    expect(await checkZoomEligibility(api(meeting({ hostId: 'u-1', status: 'waiting' })), 't', '81234567890')).toEqual({ ok: false, reason: 'not_started' });
  });
  it("leaves a meeting the token cannot read to Zoom's own start", async () => {
    for (const status of [400, 403, 404]) expect(await checkZoomEligibility(api(new ZoomApiError(status, 3001)), 't', '81234567890'), String(status)).toEqual({ ok: true, role: 'unknown' });
  });
  it('lets a refused token and a fault of the moment through to the caller', async () => {
    await expect(checkZoomEligibility(api(meeting(), new ZoomApiError(401, 124)), 't', '81234567890')).rejects.toMatchObject({ status: 401 });
    await expect(checkZoomEligibility(api(new ZoomApiError(503, undefined)), 't', '81234567890')).rejects.toMatchObject({ status: 503 });
  });
});

describe('refusalOfStart', () => {
  it("names each of the start's refusals, and nothing for a fault of the moment", () => {
    const cases: Array<[number, number | undefined, string | undefined]> = [
      [403, 2308, 'not_allowed'],
      [403, 2309, 'not_allowed'],
      [400, 2312, 'not_allowed'],
      [403, 13267, 'rtms_off'],
      [403, 13262, 'app_not_allowed'],
      [403, 13273, 'not_supported'],
      [404, 3001, 'not_found'],
      [400, 300, 'not_found'],
      [400, 3000, 'not_started'],
      [400, 2310, 'no_credits'],
      [401, 124, 'not_connected'],
      [403, 99999, 'not_allowed'],
      [404, undefined, 'not_found'],
      [400, 99999, undefined],
      [429, undefined, undefined],
      [500, undefined, undefined],
    ];
    for (const [status, code, want] of cases) expect(refusalOfStart(new ZoomApiError(status, code)), `${status} ${code}`).toBe(want);
  });
});
