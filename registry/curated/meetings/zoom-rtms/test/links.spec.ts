import { describe, it, expect } from 'vitest';
import { parseZoomJoinUrl } from '../src/links.js';

describe('parseZoomJoinUrl', () => {
  it('reads the meeting number from the forms Zoom gives a join link', () => {
    for (const url of [
      'https://zoom.us/j/81234567890',
      'https://us06web.zoom.us/j/81234567890?pwd=abcDEF123',
      'https://acme.zoom.us/j/81234567890#success',
      'https://app.zoom.us/wc/join/81234567890',
      'https://zoom.us/wc/81234567890/join',
      '  https://zoom.us/j/81234567890  ',
    ]) {
      expect(parseZoomJoinUrl(url), url).toMatchObject({ ok: true, link: { meetingNumber: '81234567890' } });
    }
    expect(parseZoomJoinUrl('https://zoom.us/j/912345678')).toMatchObject({ ok: true, link: { meetingNumber: '912345678', host: 'zoom.us' } });
  });

  it('refuses another host, a look-alike, plain http, credentials, a port, and a number that is not one', () => {
    for (const url of [
      'http://zoom.us/j/81234567890',
      'https://zoom.us.evil.test/j/81234567890',
      'https://evilzoom.us/j/81234567890',
      'https://user:pw@zoom.us/j/81234567890',
      'https://zoom.us:8443/j/81234567890',
      'https://zoom.us/j/8123',
      'https://zoom.us/j/81234567890123456',
      'https://zoom.us/j/abcdefghij',
      'https://zoom.com/j/81234567890',
      'https://zoomgov.com/j/81234567890',
      'https://meet.google.com/abc-defg-hij',
      'not a link',
    ]) {
      expect(parseZoomJoinUrl(url).ok, url).toBe(false);
    }
  });

  it('says why for a webinar, a personal link name and a host start link', () => {
    expect(parseZoomJoinUrl('https://zoom.us/w/81234567890')).toEqual({ ok: false, message: 'a webinar link; this provider serves meetings' });
    expect(parseZoomJoinUrl('https://zoom.us/my/dana.room')).toEqual({ ok: false, message: 'a personal link name; paste the link that carries the meeting number' });
    expect(parseZoomJoinUrl('https://zoom.us/s/81234567890?zak=x')).toEqual({ ok: false, message: 'a host start link; paste the join link' });
  });
});
