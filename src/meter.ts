import type { GateStore, MeterConfig } from './types.js';
import { DAY_SECONDS } from './window.js';

/**
 * The metered free tier.
 *
 * The allowance is counted in day-sized buckets summed over the trailing
 * window, NOT with the two-bucket sliding estimate the rate limiter uses. That
 * estimate smears by a whole bucket: fine at minute scale, useless at week
 * scale, where ten units spent at the start of a bucket still read as ten a
 * week later, and ten spent just before a boundary decay to five three and a
 * half days on — fifteen inside one true week. A bucket per day bounds the
 * error to a day in either direction.
 */

/** Today's bucket first, then the ones behind it. */
function dayKeys(keyId: string, windowDays: number, now: number): string[] {
  const today = Math.floor(now / 1000 / DAY_SECONDS);
  return Array.from({ length: windowDays }, (_unused, back) => `free:${keyId}:${today - back}`);
}

/** What this key has spent of its allowance over the trailing window. */
export async function unitsUsed(store: GateStore, config: MeterConfig, keyId: string, now: number): Promise<number> {
  const counts = await store.readMany(dayKeys(keyId, config.windowDays, now));
  return counts.reduce((total, n) => total + n, 0);
}

/**
 * Counted after the work succeeded, never before: a failure is not a unit.
 *
 * Nothing refunds this count — only the per-IP ceiling hands slots back — so a
 * unit spent stays spent until its day ages out.
 */
export async function recordUnit(store: GateStore, config: MeterConfig, keyId: string, now: number): Promise<number> {
  const [today, ...earlier] = dayKeys(keyId, config.windowDays, now);
  // A day longer than the window, so a bucket outlives the last sum to read it.
  const current = await store.increment(today!, DAY_SECONDS * (config.windowDays + 1));
  const rest = await store.readMany(earlier);
  return rest.reduce((total, n) => total + n, current);
}

export function ipScope(ip: string): string {
  return `free-ip:${ip}`;
}
