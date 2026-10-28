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
      // Drive's own download forms on its user-content host: /uc answers a redirect to /download for the same id.
      `https://drive.usercontent.google.com/uc?id=${ID}&export=download`,
      `https://drive.usercontent.google.com/u/0/uc?id=${ID}&export=download`,
      `https://drive.usercontent.google.com/u/0/download?id=${ID}&export=download`,
      `drive.google.com/file/d/${ID}/view`,
      // A host may end in one dot or more (https://url.spec.whatwg.org/#host-parsing keeps them all).
      `https://drive.google.com./file/d/${ID}/view`,
      `https://docs.google.com../document/d/${ID}/edit`,
      `drive.usercontent.google.com...:8443/download?id=${ID}`,
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

  /** Drive's older folder form, which Drive answers with a redirect to the folder's address for the same id. */
  it('reads /folderview?id= as the folder it redirects to', () => {
    const forms = [
      `https://drive.google.com/folderview?id=${FOLDER}`,
      `https://drive.google.com/folderview?id=${FOLDER}&usp=sharing`,
      `https://docs.google.com/folderview?id=${FOLDER}`,
      `drive.google.com/folderview?usp=sharing&id=${FOLDER}#x`,
    ];
    for (const form of forms) expect(parseDriveLink(form), form).toEqual({ kind: 'drive_folder', id: FOLDER });
    for (const form of ['https://drive.google.com/folderview', 'https://drive.google.com/folderview?id=', 'https://drive.google.com/folderview?id=a.b']) {
      expect(parseDriveLink(form), form).toEqual(REFUSED);
    }
    expect(parseDriveLink(`https://drive.usercontent.google.com/folderview?id=${FOLDER}`)).toEqual(REFUSED);
  });

  /**
   * Drive and Docs answer a signed-in account's index before the forms that name an item by their query with a redirect
   * to the same address without it: https://drive.google.com/u/0/uc?id=<id>&export=download to /uc?id=<id>&export=download,
   * /u/0/open?id=<id> to /open?id=<id>, /u/0/folderview?id=<id> to /folderview?id=<id>, alike on docs.google.com; and
   * they serve /u/0/embeddedfolderview?id=<id>. Before any other form the index stands after the form's first word.
   */
  it("reads a signed-in account's index before the forms that name an item by their query", () => {
    const files = [
      `https://drive.google.com/u/0/uc?id=${ID}&export=download`,
      `https://drive.google.com/u/0/open?id=${ID}`,
      `https://drive.google.com/u/12/open?id=${ID}&authuser=0`,
      `https://docs.google.com/u/0/uc?export=download&id=${ID}`,
      `https://docs.google.com/u/1/open?id=${ID}`,
      `drive.google.com/u/0/uc?id=${ID}`,
    ];
    for (const form of files) expect(parseDriveLink(form), form).toEqual(FILE);
    const folders = [
      `https://drive.google.com/u/0/folderview?id=${FOLDER}`,
      `https://drive.google.com/u/1/folderview?id=${FOLDER}&usp=sharing`,
      `https://docs.google.com/u/0/folderview?id=${FOLDER}`,
      `https://drive.google.com/u/0/embeddedfolderview?id=${FOLDER}`,
    ];
    for (const form of folders) expect(parseDriveLink(form), form).toEqual({ kind: 'drive_folder', id: FOLDER });
    // Drive answers 404 to an index before /file/, /drive/ or a Doc's word, and to two of them; an index that is no number,
    // and a form with no id, name no item.
    const refused = [
      `https://drive.google.com/u/0/file/d/${ID}/view`,
      `https://drive.google.com/u/0/drive/folders/${FOLDER}`,
      `https://drive.google.com/u/0/drive/mobile/folders/${FOLDER}`,
      `https://docs.google.com/u/0/document/d/${ID}/edit`,
      `https://drive.google.com/u/0/u/1/open?id=${ID}`,
      `https://drive.google.com/u/x/open?id=${ID}`,
      'https://drive.google.com/u/0/open',
      'https://drive.google.com/u/0/uc?id=a.b',
      'https://drive.google.com/u/0',
    ];
    for (const form of refused) expect(parseDriveLink(form), form).toEqual(REFUSED);
  });

  /**
   * More forms Drive serves for the same item (read on drive.google.com and docs.google.com): the embedded folder view
   * (/embeddedfolderview?id=<id>, 200, and 404 for an id no folder has), the mobile folder view
   * (/drive/mobile/folders/<id>, 200, and 404 for an id no folder has; /drive/u/0/mobile/folders/<id> redirects to it),
   * and the older Google Apps forms under a domain (/a/<domain>/): /folderview redirects to the folder, /open to the
   * file's view, /uc to its download, and /file/d/<id>/view and a Doc's, a Sheet's and a Slides deck's /<word>/d/<id>
   * answer 200. Drive answers 404 to /drive/ or an account's index after /a/<domain>/, to an account's index before it,
   * to /A/, and to a domain with no dot.
   */
  it('reads the embedded and mobile folder views and the older forms under a Google Apps domain', () => {
    const folders = [
      `https://drive.google.com/embeddedfolderview?id=${FOLDER}`,
      `https://drive.google.com/embeddedfolderview?id=${FOLDER}#list`,
      `https://docs.google.com/embeddedfolderview?id=${FOLDER}`,
      `https://drive.google.com/drive/mobile/folders/${FOLDER}`,
      `https://drive.google.com/drive/mobile/folders/${FOLDER}?usp=sharing`,
      `https://drive.google.com/drive/u/0/mobile/folders/${FOLDER}`,
      `https://docs.google.com/drive/mobile/folders/${FOLDER}`,
      `https://drive.google.com/a/example.com/folderview?id=${FOLDER}`,
      `https://docs.google.com/a/example.com/folderview?id=${FOLDER}`,
      `https://drive.google.com/a/example.com/embeddedfolderview?id=${FOLDER}`,
    ];
    for (const form of folders) expect(parseDriveLink(form), form).toEqual({ kind: 'drive_folder', id: FOLDER });
    const files = [
      `https://drive.google.com/a/example.com/open?id=${ID}`,
      `https://docs.google.com/a/example.com/open?id=${ID}&authuser=0`,
      `https://drive.google.com/a/example.com/uc?id=${ID}&export=download`,
      `https://drive.google.com/a/example.com/file/d/${ID}/view`,
      `https://docs.google.com/a/example.com/file/d/${ID}/view`,
      `https://docs.google.com/a/example.com/document/d/${ID}/edit`,
      `https://docs.google.com/a/sub.example.co.uk/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/a/example.com/presentation/d/${ID}/edit`,
      `https://drive.google.com/a/EXAMPLE.COM/open?id=${ID}`,
      `https://drive.google.com/a/example.com./open?id=${ID}`,
      `https://drive.google.com/a/xn--bcher-kva.example/open?id=${ID}`,
    ];
    for (const form of files) expect(parseDriveLink(form), form).toEqual(FILE);
    const refused = [
      'https://drive.google.com/embeddedfolderview?id=',
      'https://drive.google.com/embeddedfolderview?id=a.b',
      `https://drive.usercontent.google.com/embeddedfolderview?id=${FOLDER}`,
      `https://drive.google.com/drive/mobile/folders/${FOLDER}/extra`,
      'https://drive.google.com/drive/mobile/folders/',
      `https://drive.google.com/drive/mobile/shared-drives/${SHARED}`,
      `https://drive.google.com/a/example.com/drive/folders/${FOLDER}`,
      `https://drive.google.com/a/example.com/drive/mobile/folders/${FOLDER}`,
      `https://docs.google.com/a/example.com/drive/folders/${FOLDER}`,
      `https://drive.google.com/a/example.com/file/u/0/d/${ID}/view`,
      `https://docs.google.com/a/example.com/document/u/0/d/${ID}/edit`,
      `https://drive.google.com/a/example.com/u/0/open?id=${ID}`,
      `https://drive.google.com/u/0/a/example.com/open?id=${ID}`,
      `https://drive.google.com/a/example.com/a/example.com/open?id=${ID}`,
      `https://drive.google.com/A/example.com/open?id=${ID}`,
      `https://drive.google.com/a/example/open?id=${ID}`,
      `https://drive.google.com/a/exa%20mple.com/open?id=${ID}`,
      'https://drive.google.com/a/example.com',
      `https://drive.usercontent.google.com/a/example.com/download?id=${ID}`,
    ];
    for (const form of refused) expect(parseDriveLink(form), form).toEqual(REFUSED);
  });

  /**
   * Drive serves a Doc, a Sheet and a Slides deck by their words on docs.google.com alone. On drive.google.com,
   * /document/d/<id>, /spreadsheets/d/<id> and /presentation/d/<id> answer 404 (signed out): bare, with an account's
   * index after the word, and under a Google Apps domain (/a/<domain>/), where docs.google.com serves each for the same
   * item (200). Drive's own file view, /file/d/<id>, is served on both hosts.
   */
  it("refuses a Doc's, a Sheet's and a Slides deck's form on drive.google.com, which Drive answers 404", () => {
    const refused = [
      `https://drive.google.com/document/d/${ID}/edit`,
      `https://drive.google.com/document/d/${ID}`,
      `https://drive.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://drive.google.com/presentation/d/${ID}/edit`,
      `https://drive.google.com/document/u/0/d/${ID}/edit`,
      `https://drive.google.com/a/example.com/document/d/${ID}/edit`,
      `https://drive.google.com/a/example.com/spreadsheets/d/${ID}/edit`,
      `https://drive.google.com/a/example.com/presentation/d/${ID}/edit`,
      `drive.google.com./document/d/${ID}/edit`,
      `HTTPS://Drive.Google.COM/document/d/${ID}/edit`,
    ];
    for (const form of refused) expect(parseDriveLink(form), form).toEqual(REFUSED);
    // The same forms on docs.google.com, and the file view on either host, name the file.
    const files = [
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      `https://docs.google.com/presentation/d/${ID}/edit`,
      `https://docs.google.com/document/u/0/d/${ID}/edit`,
      `https://docs.google.com/a/example.com/document/d/${ID}/edit`,
      `https://docs.google.com/file/d/${ID}/view`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://drive.google.com/file/u/0/d/${ID}/view`,
      `https://drive.google.com/a/example.com/file/d/${ID}/view`,
    ];
    for (const form of files) expect(parseDriveLink(form), form).toEqual(FILE);
  });

  /**
   * After http, https, ws, wss and ftp the URL standard takes any run of / and \, none included, before the host
   * (https://url.spec.whatwg.org/#special-authority-slashes-state), and after file two of them; it drops the C0 controls
   * and spaces around an address and every tab and newline in it (https://url.spec.whatwg.org/#concept-basic-url-parser).
   */
  it('reads an address as the URL standard does: a special scheme without its two slashes or with backslashes, the controls and spaces around it, and tabs and newlines in it', () => {
    const files = [
      `https:drive.google.com/file/d/${ID}/view`,
      `https:/docs.google.com/document/d/${ID}/edit`,
      `http:drive.google.com/open?id=${ID}`,
      `HTTPS:///docs.google.com/document/d/${ID}/edit`,
      `https:\\\\drive.google.com\\file\\d\\${ID}\\view`,
      `https:\\/drive.usercontent.google.com/download?id=${ID}`,
      `wss:docs.google.com/spreadsheets/d/${ID}/edit`,
      `file:\\\\drive.google.com\\file\\d\\${ID}`,
      `\u0001https://drive.google.com/file/d/${ID}/view`,
      `https://docs.google.com/document/d/${ID}/edit\u0000`,
      `\u001f\u0000 https:docs.google.com/document/d/${ID}/edit \u0007`,
      `ht\ttps://drive.google.com/file/d/${ID}/view`,
      `ht\ntps:dri\r\nve.google.com/file/d/${ID.slice(0, 5)}\t${ID.slice(5)}/view`,
    ];
    for (const form of files) expect(parseDriveLink(form), JSON.stringify(form)).toEqual(FILE);
    expect(parseDriveLink(`https:drive.google.com/drive/folders/${FOLDER}`)).toEqual({ kind: 'drive_folder', id: FOLDER });
    for (const form of [`https:someone:secret@drive.google.com/file/d/${ID}/view`, `http:\\\\someone@docs.google.com\\document\\d\\${ID}\\edit`]) {
      expect(parseDriveLink(form), form).toEqual(REFUSED);
    }
    // A scheme the standard does not treat as special names a host only after "//"; another host is not Drive's.
    for (const form of [`ssh:drive.google.com/file/d/${ID}/view`, `https:example.com/file/d/${ID}/view`, '\u0001mailto:someone@drive.google.com']) {
      expect(parseDriveLink(form), JSON.stringify(form)).toBeNull();
    }
    // After file and its two slashes, a third slash or backslash leaves the host empty
    // (https://url.spec.whatwg.org/#file-host-state): the address is a path on no host, and Drive's name its first segment.
    for (const form of [`file:///drive.google.com/file/d/${ID}`, `file:\\\\\\drive.google.com\\file\\d\\${ID}`, `FILE:\\//drive.google.com/file/d/${ID}`]) {
      expect(parseDriveLink(form), JSON.stringify(form)).toBeNull();
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
      // Credentials before a Drive or Docs host with no scheme, which a browser opens as an https address.
      `someone:secret@drive.google.com/file/d/${ID}/view`,
      `someone:secret@docs.google.com/document/d/${ID}/edit`,
      `someone:secret@drive.usercontent.google.com/download?id=${ID}`,
      `https://drive.usercontent.google.com/open?id=${ID}`,
    ];
    for (const form of forms) expect(parseDriveLink(form), form).toEqual(REFUSED);
  });

  /** No form of a Drive or Docs address is ever left to be read as another site's page. */
  it('answers a Drive or Docs host as a Drive form or refused, never null, whatever the scheme, its slashes, port, path, trailing dots or controls around it', () => {
    const hosts = ['docs.google.com', 'drive.google.com', 'drive.usercontent.google.com'];
    const schemes = ['https://', 'http://', '', 'https:', 'http:/', 'https:\\\\', 'WSS:\\/', '\u0001https://', ' \u0000'];
    for (const host of hosts.flatMap((name) => [name, `${name}.`, `${name}..`])) {
      for (const scheme of schemes) {
        for (const port of ['', ':8080']) {
          for (const path of ['/', '/x', '/a/b/c', '/document/d/x/y/z', '/drive/u/9/x?y=1#z', '/folderview?id=x', '/u/0/uc?id=x', '/a/b.c/open?id=x', '/drive/mobile/folders/x']) {
            for (const tail of ['', '\u0000', ' \u001f']) {
              const form = `${scheme}${host}${port}${path}${tail}`;
              expect(parseDriveLink(form), JSON.stringify(form)).not.toBeNull();
            }
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
