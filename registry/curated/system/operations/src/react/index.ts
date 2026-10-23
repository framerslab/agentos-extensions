/**
 * @fileoverview `./react`: headless hooks for the pages and the composer, and the sanitized
 * markdown renderer (D39). This entry exists from the first release so the pack guard and a
 * product can import it; the hooks come in the next minor release and until then throw `not_built`
 * at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

export function useRequests(): never {
  return notBuilt('react.useRequests');
}

export function useRequest(): never {
  return notBuilt('react.useRequest');
}

export function useStream(): never {
  return notBuilt('react.useStream');
}

export function useComposer(): never {
  return notBuilt('react.useComposer');
}

export function useStaffList(): never {
  return notBuilt('react.useStaffList');
}

export function useStaffRequest(): never {
  return notBuilt('react.useStaffRequest');
}

export function Markdown(): never {
  return notBuilt('react.Markdown');
}
