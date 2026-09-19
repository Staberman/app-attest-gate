import { issueChallenge, registerKey, verifyRequestAssertion, KEY_TTL_SECONDS } from './attest.js';
import { isPaidTransaction } from './entitlement.js';
import { ipScope, recordUnit, unitsUsed } from './meter.js';
import { DAY_SECONDS, UNKNOWN_IP, clientIp, countInWindow, orElse, releaseFromWindow } from './window.js';
import { HEADERS, type Access, type GateConfig } from './types.js';

/**
 * One door: who is calling, and what they are allowed to spend.
 *
 * A per-install App Attest key proves the app, an App Store transaction proves
 * the purchase, and the free tier is counted here rather than on the device.
 */

const DEFAULT_MAX_KEYS_PER_PURCHASE = 6;
const DEFAULT_GRANT_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_IP_RETRY_AFTER_SECONDS = 60 * 60;

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isFresh(body: unknown, now: number, maxSkewMs: number): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const sentAt = (body as Record<string, unknown>).sentAt;
  if (typeof sentAt !== 'string') return false;
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && Math.abs(now - t) <= maxSkewMs;
}

export interface Gate {
  /** Issue a single-use challenge for a device about to register. */
  challenge(): Promise<string>;
  /** Register an attestation against a challenge you issued. */
  register(params: { keyId: unknown; challenge: unknown; attestation: unknown }): ReturnType<typeof registerKey>;
  /** Decide whether this request may proceed, and on whose budget. */
  resolve(params: { headers: Record<string, unknown>; rawBody: Buffer; body?: unknown; now?: number }): Promise<Access>;
  /** Count one unit against a key's free allowance. Call it AFTER the work succeeded. */
  recordUnit(keyId: string, now?: number): Promise<number>;
  /** Give back a per-IP slot for a request that produced nothing. */
  releaseIpSlot(ip: string, now?: number): Promise<void>;
}

export function createGate(config: GateConfig): Gate {
  const log = config.log ?? ((message: string, detail?: Record<string, unknown>) => console.warn(message, detail));

  async function resolvePaid(transaction: string, keyId: string, now: number): Promise<boolean> {
    const entitlement = config.entitlement;
    if (!entitlement) return false;

    const grantTtl = entitlement.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
    const result = await isPaidTransaction(entitlement, config.bundleId, transaction, now, log);

    if (result.paid && result.originalTransactionId) {
      // A verified purchase only counts if this install is within the
      // purchase's cap. A JWS is a bearer token: with no user accounts, a
      // shared one would otherwise grant every caller who copied it.
      const claimed = await config.store.claimPurchase(
        result.originalTransactionId,
        keyId,
        entitlement.maxKeysPerPurchase ?? DEFAULT_MAX_KEYS_PER_PURCHASE,
        KEY_TTL_SECONDS,
      );
      if (claimed) await orElse('grant write', config.store.setGrant(keyId, grantTtl), undefined, log);
      return claimed;
    }

    if (result.unavailable) {
      // Apple could not be reached. Fall back to a recent verified grant, so
      // an outage on Apple's side does not push paying users onto the free
      // tier. With nothing remembered the answer is "not paid": failing closed
      // costs a free unit, failing open hands out the product.
      const remembered = await orElse('grant read', config.store.hasGrant(keyId), false, log);
      log('entitlement verification unavailable', { keyId, honouredCachedGrant: remembered });
      return remembered;
    }

    return result.paid;
  }

  return {
    challenge: () => issueChallenge(config),

    register: (params) => registerKey(config, params),

    async resolve({ headers, rawBody, body, now = Date.now() }): Promise<Access> {
      const keyId = header(headers, HEADERS.keyId);
      const assertion = header(headers, HEADERS.assertion);

      if (!keyId || !assertion) {
        return { ok: false, status: 401, error: 'Both key id and assertion are required' };
      }

      // The signature covers the body, and the body may carry its own
      // timestamp: together they bound how long a captured request stays
      // useful, even before the counter check rejects it outright.
      if (config.maxClockSkewMs !== undefined && !isFresh(body, now, config.maxClockSkewMs)) {
        return { ok: false, status: 401, error: 'Request is stale' };
      }

      // Everything below needs the store. Without it there is no counter to
      // check, so a failure here cannot be waved through the way a failed
      // meter read can — it is reported as 503, which is what the type and
      // the README have always promised.
      let verified: Awaited<ReturnType<typeof verifyRequestAssertion>>;
      try {
        verified = await verifyRequestAssertion(config, { keyId, assertion, payload: rawBody });
      } catch (err) {
        log('store unavailable', { name: (err as Error)?.name });
        return { ok: false, status: 503, error: 'Service is not available' };
      }
      if (!verified.ok) return verified;

      if (config.rateLimit) {
        let requests: number;
        try {
          requests = await countInWindow(config.store, `key:${keyId}`, config.rateLimit.windowSeconds, now);
        } catch (err) {
          log('store unavailable', { name: (err as Error)?.name });
          return { ok: false, status: 503, error: 'Service is not available' };
        }
        if (requests > config.rateLimit.maxPerWindow) {
          return { ok: false, status: 429, error: 'Too many requests', retryAfterSeconds: config.rateLimit.windowSeconds };
        }
      }

      const ip = clientIp(headers);
      const transaction = header(headers, HEADERS.transaction);
      const paid = transaction ? await resolvePaid(transaction, keyId, now) : false;

      const meter = config.meter;
      if (!meter || paid) return { ok: true, keyId, ip, paid, unitsUsed: 0 };

      const used = await orElse('meter read', unitsUsed(config.store, meter, keyId, now), 0, log);
      if (used >= meter.perKey) {
        return { ok: false, status: 402, error: 'Free limit reached' };
      }

      // An unknown address would put every caller into one shared bucket and
      // collapse the free tier for all of them at once. Better no ceiling than
      // the wrong one; the per-key limit still holds.
      if (meter.perIpPerDay !== undefined && ip !== UNKNOWN_IP) {
        // Reserved atomically here, given back by the caller if the work
        // produces nothing. If the store cannot answer it stands open — the
        // per-key limit still holds. This is a ceiling on the NETWORK, not on
        // this key, so it reads as a rate limit rather than a spent free tier.
        const fromIp = await orElse('free ceiling', countInWindow(config.store, ipScope(ip), DAY_SECONDS, now), 0, log);
        if (fromIp > meter.perIpPerDay) {
          await orElse('free ceiling refund', releaseFromWindow(config.store, ipScope(ip), DAY_SECONDS, now), undefined, log);
          return {
            ok: false,
            status: 429,
            error: 'Too many free requests from this network',
            retryAfterSeconds: meter.ipRetryAfterSeconds ?? DEFAULT_IP_RETRY_AFTER_SECONDS,
          };
        }
      }

      return { ok: true, keyId, ip, paid, unitsUsed: used };
    },

    async recordUnit(keyId, now = Date.now()) {
      if (!config.meter) return 0;
      return recordUnit(config.store, config.meter, keyId, now);
    },

    async releaseIpSlot(ip, now = Date.now()) {
      await orElse('ip slot refund', releaseFromWindow(config.store, ipScope(ip), DAY_SECONDS, now), undefined, log);
    },
  };
}
