/**
 * @fileoverview The error a surface throws while its task is not yet built: at the call, never at
 * the import, so the package's entries exist for the pack guard from the first push.
 */

export class OpsNotBuilt extends Error {
  readonly code = 'not_built';
  readonly surface: string;
  readonly task: number;

  constructor(surface: string, task: number) {
    super(`not_built: ${surface} arrives with task ${task} of the operations package`);
    this.name = 'OpsNotBuilt';
    this.surface = surface;
    this.task = task;
  }
}

/** Throws the not-built error for `surface`. */
export function notBuilt(surface: string, task: number): never {
  throw new OpsNotBuilt(surface, task);
}

/**
 * An object of `surface`'s members, each a function that throws the not-built error when it is
 * called. `createOperations` answers these for the surfaces of later tasks.
 */
export function notBuiltSurface<T extends object>(
  surface: string,
  task: number,
  members: ReadonlyArray<keyof T & string>,
): T {
  const built: Record<string, unknown> = {};
  for (const member of members) {
    built[member] = () => notBuilt(`${surface}.${member}`, task);
  }
  return built as unknown as T;
}
