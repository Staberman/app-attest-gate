/**
 * A key that completed attestation, and the highest counter seen from it.
 *
 * Without the public key there is nothing to check a signature against, and
 * without the counter a captured assertion can be replayed forever. Both have
 * to outlive the process, which is what the `GateStore` is for.
 */
export interface AttestedKey {
  publicKey: string;
  signCount: number;
  environment: 'production' | 'development';
  registeredAt: string;
}

/**
 * Everything the gate has to remember between requests.
 *
 * Two of these operations MUST be atomic — `advanceSignCount` and
 * `claimPurchase`. Implemented as read-then-write they each open a race that
 * defeats the thing they exist to prevent: two copies of one captured
 * assertion both pass, or a burst of callers all slip past the purchase cap.
 * The bundled Upstash adapter does them as Lua scripts on the Redis server.
 * If you write your own adapter, make them atomic or do not bother.
 */
export interface GateStore {
  /** Store a single-use challenge. */
  setChallenge(challenge: string, ttlSeconds: number): Promise<void>;
  /** Returns true exactly once per challenge, then never again. Must be atomic. */
  consumeChallenge(challenge: string): Promise<boolean>;

  saveKey(keyId: string, key: AttestedKey, ttlSeconds: number): Promise<void>;
  loadKey(keyId: string): Promise<AttestedKey | null>;

  /**
   * Set the stored counter to `next` **only if** `next` is strictly greater
   * than what is stored, and report whether it moved. MUST be atomic.
   */
  advanceSignCount(keyId: string, next: number): Promise<boolean>;

  /** Increment a counter and return its new value. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** Read a counter, or 0 if it was never written. */
  read(key: string): Promise<number>;
  /** Give one increment back. Used to refund a slot for a request that failed. */
  decrement(key: string): Promise<void>;
  /** Read several counters in one round trip where the backend allows it. */
  readMany(keys: readonly string[]): Promise<number[]>;

  /**
   * Record that `keyId` uses the purchase `purchaseId`, and report whether it
   * may. A key that already claimed this purchase always passes; a new key
   * passes only while the purchase is below `maxKeys`. MUST be atomic.
   */
  claimPurchase(purchaseId: string, keyId: string, maxKeys: number, ttlSeconds: number): Promise<boolean>;

  setGrant(keyId: string, ttlSeconds: number): Promise<void>;
  hasGrant(keyId: string): Promise<boolean>;
}

export interface GateConfig {
  /** Your Apple Developer Team ID. Not a secret — it ships in every app. */
  teamId: string;
  /** The bundle identifier the attestation must be for. */
  bundleId: string;
  store: GateStore;

  /**
   * Accept development-environment attestations, which come from Xcode builds
   * and never from TestFlight or the App Store. Off by default, so a debug
   * build cannot register itself against production.
   */
  allowDevelopmentEnvironment?: boolean;

  /** Entitlement checking. Omit it and the gate is attestation-only. */
  entitlement?: EntitlementConfig;

  /** Metered free tier. Omit it and every attested caller is let through. */
  meter?: MeterConfig;

  /** Per-key request rate limit. Omit it and there is none. */
  rateLimit?: { maxPerWindow: number; windowSeconds: number };

  /**
   * How far a request's own timestamp may drift from the server clock, in ms.
   * Set it and the gate requires a `sentAt` ISO string in the body. Omit it and
   * freshness rests entirely on the sign counter.
   */
  maxClockSkewMs?: number;

  /** Where warnings go. Defaults to `console.warn`. Pass `() => {}` to silence. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface EntitlementConfig {
  /** Your app's numeric App Store ID. */
  appAppleId: number;
  /** Product identifiers that grant access. Anything else is ignored. */
  productIds: readonly string[];
  /** Products with no expiry — a lifetime unlock. Subscriptions are not listed here. */
  nonExpiringProductIds?: readonly string[];
  /** Apple root certificates, DER encoded. */
  appleRootCertificates: readonly Buffer[];
  /**
   * Accept sandbox-signed transactions. Sandbox testers are free and
   * unlimited, so this must be off in production or anyone gets the product.
   */
  allowSandbox?: boolean;
  /**
   * How many distinct install keys one purchase may entitle. A purchase JWS is
   * a bearer token, and with no user accounts a shared one would otherwise
   * grant every caller. Apple's Family Sharing ceiling is 6.
   */
  maxKeysPerPurchase?: number;
  /**
   * How long a verified purchase keeps counting after Apple's verification
   * becomes unreachable. Long enough to ride out an OCSP outage, short enough
   * that a refund is honoured within a day.
   */
  grantTtlSeconds?: number;
}

export interface MeterConfig {
  /** Free units per key per rolling window. */
  perKey: number;
  /**
   * The rolling window, in days. Counted in day-sized buckets summed over the
   * window rather than with a two-bucket sliding estimate: that estimate
   * smears by a whole bucket, which is useless at week scale.
   */
  windowDays: number;
  /**
   * Free units one network address may spend per day, across every key it
   * presents. The per-key count alone is not a limit — registration is open,
   * so a device can mint a fresh key when its own allowance runs out.
   * Keep it well above one person's allowance, and remember it also hits
   * people behind carrier-grade NAT.
   */
  perIpPerDay?: number;
  /** How long to tell a capped network to wait. */
  ipRetryAfterSeconds?: number;
}

export const HEADERS = {
  keyId: 'x-attest-key-id',
  assertion: 'x-attest-assertion',
  transaction: 'x-transaction-jws',
} as const;

export type Access =
  | { ok: true; keyId: string; ip: string; paid: boolean; unitsUsed: number }
  | { ok: false; status: 401 | 402 | 429 | 503; error: string; retryAfterSeconds?: number };
