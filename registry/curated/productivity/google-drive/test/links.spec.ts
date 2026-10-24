import { describe, expect, it } from 'vitest';
import { parseDriveLink, type DriveLink } from '../src/index.js';

/** A file id as Drive writes it: letters, digits, dashes and underscores. */
const ID = '1x2Y3z-AbCdEf_GhIjKlMnOpQrStUvWx';
/** A folder id. */
const FOLDER = '1FoLdEr-2_abcdefghijklmnopqrstuvw';
/** A shared drive's id. */
const SHARED = '0AbCdEfGhIjKlUk9PVA';

const FILE: DriveLink = { kind: 'drive_file', id: ID };
const REFUSED: DriveLink = { kind: 'refused' };

/** Exercises `parseDriveLink` over the Drive and Docs addresses a person pastes. */
describe('parseDriveLink', () => {
  /** A Doc, a Sheet, a Slides deck and any Drive file, by each of their address forms. */
  it('reads a file by every address form, whatever its scheme, port, query, fragment or account index', () => {
    const forms = [
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/document/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.abc123`,
      `https://docs.google.com/document/d/${ID}/view`,
      `https://docs.google.com/document/d/${ID}/preview`,
      `https://docs.google.com/document/d/${ID}/copy`,
      `https://docs.google.com/document/d/${ID}/export?format=pdf`,
      `https://docs.google.com/document/d/${ID}`,
      `https://docs.google.com/document/d/${ID}/`,
      `https://docs.google.com/document/u/1/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=0#gid=0`,
      `https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`,
      `https://docs.google.com/file/d/${ID}/edit`,
      `http://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com:443/document/d/${ID}/edit`,
      `HTTPS://Docs.Google.COM/document/d/${ID}/edit`,
      `docs.google.com/document/d/${ID}/edit`,
      `  https://docs.google.com/document/d/${ID}/edit  `,
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
      `https://drive.google.com/file/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}/preview`,
      `https://drive.google.com/file/d/${ID}`,
      `https://drive.google.com/file/d/${ID}/`,
      `https://drive.google.com/file/u/1/d/${ID}/view`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/open?id=${ID}&authuser=0`,
      `https://drive.google.com/uc?id=${ID}&export=download`,
      `https://drive.google.com/uc?export=download&id=${ID}`,
      `https://docs.google.com/uc?export=download&id=${ID}`,
      `https://drive.usercontent.google.com/download?id=${ID}&export=download`,
      `drive.google.com/file/d/${ID}/view`,
    ];
    for (const form of forms) expect(parseDriveLink(form), form).toEqual(FILE);
  });

  /** A folder and a shared drive, with and without the signed-in account's index. */
  it('reads a folder and a shared drive by their ids', () => {
    const folders = [
      `https://drive.google.com/drive/folders/${FOLDER}`,
      `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`,
      `https://drive.google.com/drive/folders/${FOLDER}/`,
      `https://drive.google.com/drive/u/1/folders/${FOLDER}`,
      `https://drive.google.com/drive/u/0/folders/${FOLDER}?resourcekey=0-abc`,
      `http://drive.google.com:8443/drive/folders/${FOLDER}#x`,
      `drive.google.com/drive/folders/${FOLDER}`,
    ];
    for (const form of folders) expect(parseDriveLink(form), form).toEqual({ kind: 'drive_folder', id: FOLDER });
    for (const form of [`https://drive.google.com/drive/shared-drives/${SHARED}`, `https://drive.google.com/drive/u/2/shared-drives/${SHARED}/`]) {
      expect(parseDriveLink(form), form).toEqual({ kind: 'shared_drive', id: SHARED });
    }
  });

  /** An address on Drive's hosts that names no file, folder or shared drive a grant reads. */
  it('refuses any other address on Drive and Docs hosts', () => {
    const forms = [
      'https://docs.google.com/document/d/e/2PACX-1vRabc/pub',
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vRabc/pubhtml',
      `https://docs.google.com/forms/d/${ID}/edit`,
      `https://docs.google.com/drawings/d/${ID}/edit`,
      'https://docs.google.com/document/d/',
      'https://docs.google.com/document/d/bad.id/edit',
      `https://docs.google.com/document/u/x/d/${ID}/edit`,
      'https://docs.google.com/document/',
      'https://docs.google.com/',
      `https://docs.google.com/document/d/${ID}//edit`,
      'https://drive.google.com/',
      'https://drive.google.com/drive/my-drive',
      'https://drive.google.com/drive/home',
      'https://drive.google.com/drive/folders/',
      `https://drive.google.com/drive/folders/${FOLDER}/extra`,
      'https://drive.google.com/drive/shared-drives',
      'https://drive.google.com/open',
      'https://drive.google.com/open?id=',
      'https://drive.google.com/open?id=a.b',
      'https://drive.google.com/file/d//view',
      'https://drive.usercontent.google.com/',
      `https://someone:secret@drive.google.com/file/d/${ID}/view`,
      `https://someone@docs.google.com/document/d/${ID}/edit`,
    ];
    for (const form of forms) expect(parseDriveLink(form), form).toEqual(REFUSED);
  });

  /** No form of a Drive or Docs address is ever left to be read as another site's page. */
  it('answers a Drive or Docs host as a Drive form or refused, never null, whatever the scheme, port or path', () => {
    for (const host of ['docs.google.com', 'drive.google.com', 'drive.usercontent.google.com']) {
      for (const scheme of ['https://', 'http://', '']) {
        for (const port of ['', ':8080']) {
          for (const path of ['/', '/x', '/a/b/c', '/document/d/x/y/z', '/drive/u/9/x?y=1#z']) {
            const form = `${scheme}${host}${port}${path}`;
            expect(parseDriveLink(form), form).not.toBeNull();
          }
        }
      }
    }
  });

  /** Another host's address is not Drive's. */
  it("answers null for an address that is not Drive's, and for text that is no address", () => {
    const forms = [
      'https://sites.google.com/view/acme',
      'https://www.google.com/drive/',
      `https://example.com/file/d/${ID}/view`,
      `https://drive.google.com.example.org/file/d/${ID}/view`,
      'https://lh3.googleusercontent.com/abc',
      'https://github.com/acme-team/handbook',
      'mailto:someone@drive.google.com',
      'not a link',
      '',
    ];
    for (const form of forms) expect(parseDriveLink(form), form).toBeNull();
  });

  /** A value that is not text is a caller's mistake. */
  it('refuses a value that is not text with a TypeError', () => {
    expect(() => parseDriveLink(42 as unknown as string)).toThrow(TypeError);
  });
});
