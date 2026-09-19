import type { AttestedKey, GateStore } from '../types.js';

/**
 * An in-process store. Use it in tests and on a laptop, never in production:
 * a serverless function loses it on every cold start, and two instances do not
 * share it — which means no replay protection at all.
 *
 * The operations the interface requires to be atomic are atomic here for free,
 * because JavaScript will not interleave them.
 */
export function createMemoryStore(now: () => number = Date.now): GateStore {
  const values = new Map<string, { value: unknown; expiresAt: number }>();

  const live = (key: string): unknown => {
    const entry = values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const put = (key: string, value: unknown, ttlSeconds: number): void => {
    values.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
  };

  const counter = (key: string): number => {
    const value = live(key);
    return typeof value === 'number' ? value : 0;
  };

  return {
    async setChallenge(challenge, ttlSeconds) {
      put(`challenge:${challenge}`, true, ttlSeconds);
    },
    async consumeChallenge(challenge) {
      const key = `challenge:${challenge}`;
      if (live(key) === undefined) return false;
      values.delete(key);
      return true;
    },
    async saveKey(keyId, key, ttlSeconds) {
      put(`attest:${keyId}`, key, ttlSeconds);
    },
    async loadKey(keyId) {
      return (live(`attest:${keyId}`) as AttestedKey | undefined) ?? null;
    },
    async advanceSignCount(keyId, next) {
      const key = `attest:${keyId}`;
      const stored = live(key) as AttestedKey | undefined;
      if (!stored) return false;
      if (next <= stored.signCount) return false;
      const entry = values.get(key)!;
      values.set(key, { value: { ...stored, signCount: next }, expiresAt: entry.expiresAt });
      return true;
    },
    async increment(key, ttlSeconds) {
      const next = counter(key) + 1;
      const existing = values.get(key);
      // Only the first increment sets the expiry, as INCR + EXPIRE does.
      if (existing && existing.expiresAt > now()) {
        values.set(key, { value: next, expiresAt: existing.expiresAt });
      } else {
        put(key, next, ttlSeconds);
      }
      return next;
    },
    async read(key) {
      return counter(key);
    },
    async decrement(key) {
      const existing = values.get(key);
      if (!existing || existing.expiresAt <= now()) return;
      values.set(key, { value: counter(key) - 1, expiresAt: existing.expiresAt });
    },
    async readMany(keys) {
      return keys.map(counter);
    },
    async claimPurchase(purchaseId, keyId, maxKeys, ttlSeconds) {
      const key = `purchase:${purchaseId}`;
      const holders = (live(key) as Set<string> | undefined) ?? new Set<string>();
      if (holders.has(keyId)) return true;
      if (holders.size >= maxKeys) return false;
      holders.add(keyId);
      put(key, holders, ttlSeconds);
      return true;
    },
    async setGrant(keyId, ttlSeconds) {
      put(`grant:${keyId}`, true, ttlSeconds);
    },
    async hasGrant(keyId) {
      return live(`grant:${keyId}`) !== undefined;
    },
  };
}
