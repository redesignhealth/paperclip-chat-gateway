/**
 * A tiny memoizing cache for a single async value, with one deliberate
 * property that `promise ?? (promise = factory())`-style memoization
 * usually gets wrong: a rejection is never cached permanently. If the
 * factory rejects, the cache resets itself so the *next* `get()` retries
 * from scratch instead of replaying the same rejection forever.
 *
 * This exists because `RealOidcPort` caches OIDC discovery for the process
 * lifetime (discovery is a real network round-trip we don't want to repeat
 * on every login). Without reset-on-rejection, a single transient IdP
 * outage during the very first login attempt would permanently break every
 * subsequent login until the process restarts.
 */
export interface CachedAsync<T> {
  /** Returns the cached value, computing (and caching) it on first call. */
  get(): Promise<T>;
  /** Forces the next `get()` to recompute, even if a value is cached. */
  reset(): void;
}

export function createCachedAsync<T>(factory: () => Promise<T>): CachedAsync<T> {
  let cached: Promise<T> | null = null;

  return {
    async get(): Promise<T> {
      if (!cached) {
        cached = factory().catch((error: unknown) => {
          // Never cache a rejection: let the next get() try again.
          cached = null;
          throw error;
        });
      }
      return cached;
    },
    reset(): void {
      cached = null;
    },
  };
}
