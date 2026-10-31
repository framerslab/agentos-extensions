// The pack as a consumer's own Node process meets it. `@framers/agentos-ext-google-drive` is imported by its name: this
// file sits inside the package, so the name goes through the package's exports map (Node's package self-reference, the
// map an installed copy is resolved through) to the build, and the build's `micromark` dependency and its
// `@framers/agentos-ext-account-sources` peer load as Node loads them. Drive is called with the global fetch at the
// stand-in whose origin is the first argument. The calls are the README's: `GoogleDrivePickedConnector.read` of a picked
// file, `exportDoc` of a Doc read by itself with `exportPastCap` on its failure, and `withoutEmbeddedPictures` of
// Markdown the caller holds.
//
//   node picked-doc.mjs <Drive origin> <access token> <maxFileBytes> <calls as JSON>
//
// Prints a line naming the files the imports resolved to, then one line per call, each `consumer ` and a JSON object.

const pack = await import('@framers/agentos-ext-google-drive');
const { DriveRequestError, exportDoc, exportPastCap, GoogleDrivePickedConnector, withoutEmbeddedPictures } = pack;
const { ReadCapExceeded } = await import('@framers/agentos-ext-account-sources');

const [baseUrl, token, maxText, callsText] = process.argv.slice(2);
const maxFileBytes = Number(maxText);
const calls = JSON.parse(callsText);

/** One line of the output. */
const print = (value) => process.stdout.write(`consumer ${JSON.stringify(value)}\n`);

/** Content as the caller's loader of its type reads it: its type, its length in bytes and its text. */
const content = ({ bytes, mediaType }) => ({ mediaType, byteLength: bytes.byteLength, text: new TextDecoder().decode(bytes) });

/** A failure as a caller tells it apart: its name, Google's status, reason and domain, the cap, its class, and `exportPastCap`. */
const failure = (error) => ({
  name: error?.name,
  status: error?.status,
  reason: error?.reason,
  domain: error?.domain,
  maxBytes: error?.maxBytes,
  driveRequestError: error instanceof DriveRequestError,
  readCapExceeded: error instanceof ReadCapExceeded,
  pastCap: exportPastCap(error),
});

print({
  call: 'resolve',
  entry: import.meta.resolve('@framers/agentos-ext-google-drive'),
  accountSources: import.meta.resolve('@framers/agentos-ext-account-sources'),
  micromark: import.meta.resolve('micromark'),
  names: Object.keys(pack).sort(),
});

const connector = new GoogleDrivePickedConnector(async () => token, { ownedOnly: true, maxFileBytes, baseUrl });
for (const { call, id, markdown } of calls) {
  let answer;
  try {
    if (call === 'read') {
      const read = await connector.read({ id, title: '', size: null, version: null });
      answer = 'reason' in read ? { gone: read } : { item: read.item, content: content(read.content), ref: read.ref };
    } else if (call === 'exportDoc') {
      answer = { content: content(await exportDoc(token, id, maxFileBytes, { baseUrl })) };
    } else if (call === 'withoutEmbeddedPictures') {
      const kept = withoutEmbeddedPictures(markdown);
      answer = { text: kept, unchanged: kept === markdown };
    } else {
      throw new TypeError(`no call named ${call}`);
    }
  } catch (error) {
    answer = { failure: failure(error) };
  }
  print({ call, id, answer });
}
