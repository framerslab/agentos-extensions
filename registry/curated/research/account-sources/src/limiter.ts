import { LimiterRefused, SourceLimiter } from '@framers/agentos-ext-public-sources';

/** The shared per-process limiter, its refusal, and its Retry-After parser. */
export { SourceLimiter, LimiterRefused, retryAfterMs } from '@framers/agentos-ext-public-sources';

/** Runs a response-producing call under the limiter and blocks it on a 429 or 503 before throwing. */
export async function readThroughLimiter(limiter: SourceLimiter, call: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  /** Checks the response while the call still holds the limiter's slot. */
  const read = async (): Promise<Response> => {
    const response = await call();
    if (response.status === 429 || response.status === 503) {
      limiter.block(response.headers.get('retry-after'));
      try {
        await response.body?.cancel();
      } catch {
        // Cleanup failure must not replace the limiter refusal.
      }
      throw new LimiterRefused('blocked');
    }
    return response;
  };
  return limiter.run(read, signal);
}
