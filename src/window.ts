import type { GateStore } from './types.js';

/**
 * Counting things per caller per window, shared across instances.
 *
 * The window slides. A fixed bucket lets a caller spend a full allowance at
 * the end of one bucket and another at the start of the next — twice the limit
 * in a few seconds. This is the two-bucket approximation: the previous
 * bucket's count is weighted by how much of it still overlaps a window ending
 * now, so the estimate decays smoothly instead of resetting. Two counters per
 * scope, no sorted sets.
 */

export const DAY_SECONDS = 60 * 60 * 24;

/** Exported because the weighting is the whole idea and worth testing alone. */
export function slidingEstimate(current: number, previous: number, elapsedFraction: number): number {
  const overlap = Math.max(0, Math.min(1, 1 - elapsedFraction));
  return Math.ceil(current + previous * overlap);
}

function windowKeys(scope: string, windowSeconds: number, now: number) {
  const seconds = now / 1000;
  const bucket = Math.floor(seconds / windowSeconds);
  return {
    currentKey: `rl:${scope}:${bucket}`,
    previousKey: `rl:${scope}:${bucket - 1}`,
    elapsedFraction: (seconds - bucket * windowSeconds) / windowSeconds,
  };
}

/** Counts this request and returns the sliding estimate including it. */
export async function countInWindow(store: GateStore, scope: string, windowSeconds: number, now: number): Promise<number> {
  const { currentKey, previousKey, elapsedFraction } = windowKeys(scope, windowSeconds, now);
  // Kept for two windows: this bucket is the "previous" one during the next.
  const current = await store.increment(currentKey, windowSeconds * 2);
  const previous = await store.read(previousKey);
  return slidingEstimate(current, previous, elapsedFraction);
}

/**
 * Undoes one `countInWindow` for a request that was not served.
 *
 * A request that straddles a bucket edge between the count and the refund
 * drifts the estimate by one slot at most, which is cheaper than charging
 * people for requests you refused.
 */
export async function releaseFromWindow(store: GateStore, scope: string, windowSeconds: number, now: number): Promise<void> {
  await store.decrement(windowKeys(scope, windowSeconds, now).currentKey);
}

/** Policy for store calls not worth a 500: warn, fall back, carry on. */
export function orElse<T>(
  what: string,
  op: Promise<T>,
  fallback: T,
  log: (message: string, detail?: Record<string, unknown>) => void,
): Promise<T> {
  return op.catch((err) => {
    log(`${what} unavailable`, { name: (err as Error)?.name });
    return fallback;
  });
}

/** What `clientIp` returns when no address header is present. */
export const UNKNOWN_IP = 'unknown';

/**
 * First entry of `x-forwarded-for`, or `x-real-ip`.
 *
 * ⚠️ **A client can forge both of these.** Any per-IP ceiling you build on this
 * is only as trustworthy as the proxy in front of you: it must OVERWRITE the
 * header rather than append to it. Vercel, Cloudflare and a correctly
 * configured nginx do. A bare Node server does not, and there the ceiling is
 * advisory at best.
 */
export function clientIp(headers: Record<string, unknown>): string {
  const read = (name: string): string | undefined => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const forwarded = read('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return read('x-real-ip') ?? UNKNOWN_IP;
}
