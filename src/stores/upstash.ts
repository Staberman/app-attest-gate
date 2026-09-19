import type { AttestedKey, GateStore } from '../types.js';

/**
 * The shape this adapter needs from a Redis client. Declared structurally so
 * the package does not depend on `@upstash/redis` — pass the real client, or
 * anything that speaks the same five methods.
 *
 * `eval` is not optional: the two atomic operations are Lua scripts, and a
 * client that cannot run them cannot implement this interface safely.
 */
export interface RedisLike {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown, options?: { ex?: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Advance the counter only if the new value is strictly greater, in one step.
 *
 * Read-then-write leaves a gap: two copies of the same captured assertion
 * arriving together both read the old counter, both pass the "greater than"
 * check, and both go through. Doing the comparison and the write on the Redis
 * server means exactly one of them wins. This is the whole replay defence.
 */
const ADVANCE_SIGN_COUNT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if tonumber(ARGV[1]) <= tonumber(record.signCount) then return 0 end
record.signCount = tonumber(ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ttl)
else
  redis.call('SET', KEYS[1], cjson.encode(record))
end
return 1
`;

/**
 * Claim a purchase for an install key, without letting a burst of callers all
 * slip past the ceiling at once.
 */
const CLAIM_PURCHASE = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

export function createUpstashStore(redis: RedisLike): GateStore {
  const counter = async (key: string): Promise<number> => {
    const value = await redis.get<number>(key);
    return typeof value === 'number' ? value : 0;
  };

  return {
    async setChallenge(challenge, ttlSeconds) {
      await redis.set(`challenge:${challenge}`, '1', { ex: ttlSeconds });
    },
    async consumeChallenge(challenge) {
      // DEL reports how many keys it removed, which makes it the atomic
      // test-and-clear this needs.
      return (await redis.del(`challenge:${challenge}`)) === 1;
    },
    async saveKey(keyId, key, ttlSeconds) {
      await redis.set(`attest:${keyId}`, key, { ex: ttlSeconds });
    },
    async loadKey(keyId) {
      return (await redis.get<AttestedKey>(`attest:${keyId}`)) ?? null;
    },
    async advanceSignCount(keyId, next) {
      return (await redis.eval(ADVANCE_SIGN_COUNT, [`attest:${keyId}`], [String(next)])) === 1;
    },
    async increment(key, ttlSeconds) {
      const value = await redis.incr(key);
      // Only the first increment sets the expiry, so the window does not slide
      // forward every time someone touches it.
      if (value === 1) await redis.expire(key, ttlSeconds);
      return value;
    },
    async read(key) {
      return counter(key);
    },
    async decrement(key) {
      await redis.decr(key);
    },
    async readMany(keys) {
      return Promise.all(keys.map(counter));
    },
    async claimPurchase(purchaseId, keyId, maxKeys, ttlSeconds) {
      const result = await redis.eval(
        CLAIM_PURCHASE,
        [`purchase:${purchaseId}`],
        [keyId, String(maxKeys), String(ttlSeconds)],
      );
      return result === 1;
    },
    async setGrant(keyId, ttlSeconds) {
      await redis.set(`grant:${keyId}`, '1', { ex: ttlSeconds });
    },
    async hasGrant(keyId) {
      const value = await redis.get(`grant:${keyId}`);
      return value !== null && value !== undefined;
    },
  };
}
