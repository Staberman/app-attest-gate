import { randomBytes } from 'node:crypto';
import { verifyAttestation, verifyAssertion } from 'node-app-attest';
import type { GateConfig } from './types.js';

/**
 * App Attest: a device identity that replaces a shared secret.
 *
 * The private key is generated inside the Secure Enclave and never leaves it,
 * so there is nothing in the binary to extract. Registration proves, through a
 * certificate chain rooted at Apple, that the key belongs to a genuine copy of
 * your app on genuine hardware. Every request after that is signed with it.
 *
 * The cryptography here is `node-app-attest`'s. What this module adds is the
 * state machine around it: single-use challenges, a counter that only moves
 * up, and an environment check that is re-run on every assertion.
 *
 * https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server
 */

const CHALLENGE_TTL_SECONDS = 60 * 5;
export const KEY_TTL_SECONDS = 60 * 60 * 24 * 365;

export type RegisterResult =
  | { ok: true; /** False when this key id was already on file. */ created: boolean }
  | { ok: false; error: string };

export type AssertionResult = { ok: true; keyId: string } | { ok: false; status: 401; error: string };

export async function issueChallenge(config: GateConfig): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  await config.store.setChallenge(challenge, CHALLENGE_TTL_SECONDS);
  return challenge;
}

export async function registerKey(
  config: GateConfig,
  params: { keyId: unknown; challenge: unknown; attestation: unknown },
): Promise<RegisterResult> {
  const { keyId, challenge, attestation } = params;
  const warn = config.log ?? ((m, d) => console.warn(m, d));

  if (typeof keyId !== 'string' || keyId.length === 0) return { ok: false, error: 'keyId is required' };
  if (typeof challenge !== 'string' || challenge.length === 0) return { ok: false, error: 'challenge is required' };
  if (typeof attestation !== 'string' || attestation.length === 0) return { ok: false, error: 'attestation is required' };

  // A challenge is good for exactly one registration. Checking this first
  // means a replayed registration never reaches the certificate work.
  if (!(await config.store.consumeChallenge(challenge))) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }

  let verified: { publicKey: string; environment: string };
  try {
    verified = verifyAttestation({
      attestation: Buffer.from(attestation, 'base64'),
      challenge,
      keyId,
      bundleIdentifier: config.bundleId,
      teamIdentifier: config.teamId,
      allowDevelopmentEnvironment: config.allowDevelopmentEnvironment === true,
    });
  } catch (err) {
    warn('attestation rejected', { reason: (err as Error).message });
    return { ok: false, error: 'Attestation could not be verified' };
  }

  // Re-registering a key id that is already on file must NOT reset its
  // counter: a fresh zero would make every assertion captured under the old
  // counter valid again. The counter only ever moves up.
  const existing = await config.store.loadKey(keyId);

  await config.store.saveKey(
    keyId,
    {
      publicKey: verified.publicKey,
      signCount: Math.max(existing?.signCount ?? 0, 0),
      environment: verified.environment === 'production' ? 'production' : 'development',
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    },
    KEY_TTL_SECONDS,
  );

  return { ok: true, created: existing === null };
}

/**
 * Checks that `payload` — the raw request body, byte for byte — was signed by
 * the key registered under `keyId`, and that this signature has not been seen.
 *
 * Pass the bytes you received, not a re-serialised object. `JSON.stringify` of
 * a parsed body is not guaranteed to reproduce them, and a single differing
 * byte fails every signature. This is the most common way App Attest is broken.
 */
export async function verifyRequestAssertion(
  config: GateConfig,
  params: { keyId: string; assertion: string; payload: Buffer },
): Promise<AssertionResult> {
  const { keyId, assertion, payload } = params;
  const warn = config.log ?? ((m, d) => console.warn(m, d));

  const key = await config.store.loadKey(keyId);
  if (!key) return { ok: false, status: 401, error: 'Unknown key' };

  // Registration already refuses development attestations unless allowed, but
  // a key registered while the flag was on would otherwise keep working after
  // it is turned off. The stored environment is checked on EVERY request, so
  // flipping the flag actually revokes those keys.
  if (key.environment !== 'production' && config.allowDevelopmentEnvironment !== true) {
    warn('assertion rejected', { keyId, reason: 'development key not allowed' });
    return { ok: false, status: 401, error: 'Key environment not allowed' };
  }

  let signCount: number;
  try {
    ({ signCount } = verifyAssertion({
      assertion: Buffer.from(assertion, 'base64'),
      payload,
      publicKey: key.publicKey,
      bundleIdentifier: config.bundleId,
      teamIdentifier: config.teamId,
      signCount: key.signCount,
    }));
  } catch (err) {
    warn('assertion rejected', { keyId, reason: (err as Error).message });
    return { ok: false, status: 401, error: 'Invalid assertion' };
  }

  // The library compared the counter against the value we loaded. This makes
  // the same comparison again atomically at write time, which is the one that
  // counts when two copies of a captured request race each other.
  if (!(await config.store.advanceSignCount(keyId, signCount))) {
    return { ok: false, status: 401, error: 'Assertion already used' };
  }

  return { ok: true, keyId };
}
