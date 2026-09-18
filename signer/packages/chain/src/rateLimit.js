/**
 * Pacing RPC calls to a provider's quota.
 *
 * `withRpcRetry` recovers from a 429 after the fact; this stops most of them
 * from happening. Calls are spaced evenly at `1000 / maxRps` ms rather than
 * bucketed per second, because a burst of N calls in the first millisecond of
 * a second is exactly what a shared Helius key rejects.
 *
 * The limit is per process. Four services on one key, each set to 10 rps,
 * present the provider with 40.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a process sends when nobody has said otherwise. */
export const DEFAULT_MAX_RPS = 20;

/** `RPC_MAX_RPS`; unset or empty means `DEFAULT_MAX_RPS`, 0 means unlimited. */
export function configuredMaxRps(env = process.env) {
  const raw = env.RPC_MAX_RPS;
  if (raw == null || raw === '') return DEFAULT_MAX_RPS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`RPC_MAX_RPS must be a non-negative number, got ${raw}`);
  return value;
}

/**
 * A scheduler: `limit(fn)` runs `fn` no sooner than its turn. Turns are
 * handed out in call order, so a caller that arrives while others are queued
 * waits behind them rather than racing for the next slot.
 */
export function rateLimiter(maxRps, { now = Date.now, wait = sleep } = {}) {
  if (!(maxRps > 0)) return (fn) => fn();
  const interval = 1000 / maxRps;
  let next = 0;

  return async (fn) => {
    const current = now();
    const turn = Math.max(current, next);
    next = turn + interval;
    if (turn > current) await wait(turn - current);
    return fn();
  };
}

/** A `fetch` that goes through `limit`, for `Connection`'s `fetch` option. */
export function rateLimitedFetch(limit, fetchImpl = globalThis.fetch) {
  return (input, init) => limit(() => fetchImpl(input, init));
}
