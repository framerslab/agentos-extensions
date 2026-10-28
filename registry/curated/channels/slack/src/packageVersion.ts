/**
 * @fileoverview The version of the package this pack ships in, which the pack and its tools report to their host.
 *
 * @module @framers/agentos-ext-channel-slack/packageVersion
 */

/**
 * The version of the package this pack ships in, read from its `package.json`. That file sits one folder above both
 * `src` and the built `dist`, and every published tarball carries it, so each release reports its own version with no
 * edit here. The pack builds as CommonJS, where `require` reads a JSON file.
 */
export const PACKAGE_VERSION: string = (require('../package.json') as { version: string }).version;
