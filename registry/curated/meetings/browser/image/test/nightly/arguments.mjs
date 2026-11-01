// The nightly real-join check's arguments: `--platform` picks one platform, and `--identity`, repeatable, names the
// Google Meet identities the check sends one run each for, in the order given; with none, one run naming no identity,
// which the scheduler gives its configured default.
import { parseArgs } from 'node:util';

/** The folder-name form a scheduler accepts (`IDENTITY_NAME` in the pack's protocol). */
const IDENTITY = /^[a-z0-9-]{1,32}$/;

/**
 * Reads `argv` (the process's arguments after the program's): `{ platform, identities }`, `platform` undefined for both
 * platforms, `identities` the names in order, or `[undefined]` for one run naming none. Throws on an argument that is not
 * one of the two options, a platform outside `platforms`, an identity outside the folder-name form, or a name given twice.
 */
export function readArguments(argv, platforms) {
  const { values } = parseArgs({ args: argv, options: { platform: { type: 'string' }, identity: { type: 'string', multiple: true } } });
  if (values.platform !== undefined && !platforms.includes(values.platform)) throw new Error(`there is no platform ${values.platform}`);
  const identities = values.identity ?? [];
  for (const name of identities) if (!IDENTITY.test(name)) throw new Error('an identity is a folder name: lower-case letters, digits and hyphens, 1 to 32');
  if (new Set(identities).size !== identities.length) throw new Error('an identity is named once');
  return { platform: values.platform, identities: identities.length === 0 ? [undefined] : identities };
}
