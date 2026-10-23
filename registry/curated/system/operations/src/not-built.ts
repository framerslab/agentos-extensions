/**
 * @fileoverview The error a surface of the next minor release throws in this one: at the call,
 * never at the import, so every entry exists for the pack guard and a product can import it
 * before the surface is there.
 */

/** When the surface comes, as the error says it. */
const COMES = 'it comes in the next minor release of @framers/agentos-ext-operations';

export class OpsNotBuilt extends Error {
  readonly code = 'not_built';
  readonly surface: string;

  constructor(surface: string) {
    super(`not_built: ${surface} is not in this release; ${COMES}`);
    this.name = 'OpsNotBuilt';
    this.surface = surface;
  }
}

/** Throws the not-built error for `surface`. */
export function notBuilt(surface: string): never {
  throw new OpsNotBuilt(surface);
}

/**
 * An object of `surface`'s members, each a function that throws the not-built error when it is
 * called. `createOperations` answers these for the surfaces of the next minor release.
 */
export function notBuiltSurface<T extends object>(surface: string, members: ReadonlyArray<keyof T & string>): T {
  const built: Record<string, unknown> = {};
  for (const member of members) {
    built[member] = () => notBuilt(`${surface}.${member}`);
  }
  return built as unknown as T;
}
