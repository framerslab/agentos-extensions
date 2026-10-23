/**
 * @fileoverview `./react`: headless hooks for the pages and the composer, and the sanitized
 * markdown renderer (D39). This entry exists from the first release so the pack guard and a
 * product can import it; the hooks come in the next minor release and until then throw `not_built`
 * at the call, never at the import.
 */
import { notBuilt } from '../not-built.js';

/**
 * The hook for a person's list of requests, in the next minor release (D39); until then it throws
 * `not_built` at the call.
 */
export function useRequests(): never {
  return notBuilt('react.useRequests');
}

/**
 * The hook for one request, in the next minor release (D39); until then it throws `not_built` at
 * the call.
 */
export function useRequest(): never {
  return notBuilt('react.useRequest');
}

/**
 * The hook for a request's live stream, in the next minor release (D39); until then it throws
 * `not_built` at the call.
 */
export function useStream(): never {
  return notBuilt('react.useStream');
}

/**
 * The hook for the composer, in the next minor release (D39); until then it throws `not_built` at
 * the call.
 */
export function useComposer(): never {
  return notBuilt('react.useComposer');
}

/**
 * The hook for staff's list of requests, in the next minor release (D39); until then it throws
 * `not_built` at the call.
 */
export function useStaffList(): never {
  return notBuilt('react.useStaffList');
}

/**
 * The hook for staff's view of one request, in the next minor release (D39); until then it throws
 * `not_built` at the call.
 */
export function useStaffRequest(): never {
  return notBuilt('react.useStaffRequest');
}

/**
 * The sanitized markdown renderer, in the next minor release (D39); until then it throws
 * `not_built` at the call.
 */
export function Markdown(): never {
  return notBuilt('react.Markdown');
}
