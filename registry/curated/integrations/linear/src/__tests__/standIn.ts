/**
 * @fileoverview A fetch stand-in for the pack's tests: it records every request and answers from a route, with a JSON
 * answer, a GraphQL route by operation name, and a fetch that never answers.
 */

/** One request the stand-in received. */
export interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
  /** The redirect mode the call was made with, so a test can pin that no redirect is followed. */
  redirect: RequestInit['redirect'];
  /** The credentials mode the call was made with. */
  credentials: RequestInit['credentials'];
}

/** A fetch that answers from `route` and records every request. */
export function standIn(route: (request: Seen) => Response | Promise<Response>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: Seen = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
      credentials: init?.credentials,
    };
    seen.push(request);
    return route(request);
  };
  return { fetchImpl, seen };
}

/** A JSON answer. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that never answers, rejecting with its signal's reason when the signal aborts, as fetch does. */
export const neverAnswers: typeof fetch = async (_input, init) => {
  const signal = init?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

/** A GraphQL request's variables. */
export type Variables = Record<string, unknown>;

/**
 * A route over GraphQL requests: it reads the request's JSON body and answers `route(operationName, variables, query)`,
 * a `Response` as it is or any other value as a JSON answer with status 200.
 */
export function graphql(
  route: (operationName: string, variables: Variables, query: string) => unknown,
): (request: Seen) => Response {
  return (request) => {
    const body = JSON.parse(request.body ?? '{}') as { operationName?: unknown; variables?: unknown; query?: unknown };
    const name = typeof body.operationName === 'string' ? body.operationName : '';
    const variables = typeof body.variables === 'object' && body.variables !== null ? (body.variables as Variables) : {};
    const query = typeof body.query === 'string' ? body.query : '';
    const answer = route(name, variables, query);
    return answer instanceof Response ? answer : json(answer);
  };
}

/** The request body of a call as a form. */
export function form(request: Seen | undefined): URLSearchParams {
  return new URLSearchParams(request?.body ?? '');
}

/** The JSON body of a GraphQL call. */
export function sent(request: Seen | undefined): { operationName: string; query: string; variables: Variables } {
  return JSON.parse(request?.body ?? '{}') as { operationName: string; query: string; variables: Variables };
}
