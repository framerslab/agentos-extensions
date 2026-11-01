/**
 * @fileoverview This package's own name and version, which the pack reports to its host.
 *
 * @module @framers/agentos-ext-image-editing/packageVersion
 */

import { createRequire } from 'node:module';

/** This package's name: a package.json is this package's own only when its `name` field holds it. */
export const PACKAGE_NAME = '@framers/agentos-ext-image-editing';

/**
 * This package's version, read from the package.json one folder above this file, the package's root both from `dist/`
 * and from `src/`. A bundler that leaves createRequire to run at load (esbuild:
 * https://github.com/evanw/esbuild/issues/1828) moves this code away from that file, so the path can name the host's
 * package.json or no file at all. The version is then undefined, which `ExtensionPack.version` allows: the pack never
 * reports the host's number and never fails the host's import.
 */
export const PACKAGE_VERSION: string | undefined = readPackageVersion();

function readPackageVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('../package.json') as { name?: unknown; version?: unknown };
    return manifest.name === PACKAGE_NAME && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Warns through the host's logger when the pack reports no version, so the host knows why. */
export function warnWhenVersionUnknown(logger?: { warn?: (message: string) => void }): void {
  if (PACKAGE_VERSION === undefined) {
    logger?.warn?.(
      `${PACKAGE_NAME}: no package.json naming this package sits one folder above its code; reporting no version`,
    );
  }
}
