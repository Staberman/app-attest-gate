import type { EntitlementConfig } from './types.js';

/**
 * Whether the caller has paid, decided on the server and not on the device.
 *
 * StoreKit 2 hands the app a transaction signed by Apple. The app forwards it,
 * and the signature is checked against Apple's root certificate — so a device
 * cannot claim a purchase it does not have, and a free tier can be metered
 * somewhere the user cannot edit.
 *
 * `@apple/app-store-server-library` is an OPTIONAL dependency, loaded only if
 * you configure entitlements. Attestation-only users do not pay for it.
 */

export interface PaidTransaction {
  paid: boolean;
  /**
   * Identifies the purchase across renewals and restores, for binding it to a
   * bounded set of installs. Present only when a transaction verified.
   */
  originalTransactionId?: string;
  /**
   * True when the answer is unknown rather than "no": the signature could not
   * be checked because Apple's revocation service or the network was down.
   * The caller decides what an unknown is worth; here it is never "paid".
   */
  unavailable?: boolean;
}

interface AppleLibrary {
  SignedDataVerifier: new (
    roots: readonly Buffer[],
    online: boolean,
    environment: unknown,
    bundleId: string,
    appAppleId?: number,
  ) => { verifyAndDecodeTransaction(jws: string): Promise<DecodedTransaction> };
  Environment: { PRODUCTION: unknown; SANDBOX: unknown };
  VerificationException: new (...args: never[]) => { status: unknown };
  VerificationStatus: { RETRYABLE_VERIFICATION_FAILURE: unknown };
}

export interface DecodedTransaction {
  bundleId?: string;
  productId?: string;
  revocationDate?: number | null;
  expiresDate?: number | null;
  originalTransactionId?: string;
}

let library: AppleLibrary | null = null;

async function appleLibrary(): Promise<AppleLibrary> {
  if (library) return library;
  try {
    library = (await import('@apple/app-store-server-library')) as unknown as AppleLibrary;
  } catch {
    throw new Error(
      'Entitlement checking needs the optional peer dependency @apple/app-store-server-library. ' +
        'Install it, or omit `entitlement` from the gate config.',
    );
  }
  return library;
}

/**
 * Does this decoded transaction grant access right now?
 *
 * Exported because it is pure and worth testing directly — the interesting
 * cases are a revoked family share and a subscription with no expiry.
 */
export function grantsAccess(config: EntitlementConfig, transaction: DecodedTransaction, bundleId: string, now: number): boolean {
  if (transaction.bundleId !== bundleId) return false;
  if (!transaction.productId || !config.productIds.includes(transaction.productId)) return false;
  // A refund or a revoked family share ends access.
  if (transaction.revocationDate !== undefined && transaction.revocationDate !== null) return false;

  if (config.nonExpiringProductIds?.includes(transaction.productId)) return true;

  // Subscriptions carry an expiry; a missing one is treated as not active
  // rather than as forever.
  return typeof transaction.expiresDate === 'number' && transaction.expiresDate > now;
}

/**
 * Whether a verification failure says something about the transaction or about
 * the moment.
 *
 * The verifier does live OCSP checks on the certificate chain. When those
 * requests fail the library reports it as retryable, and that must not be read
 * as "this purchase is fake" — that is how an outage on Apple's side bills a
 * paying customer a free unit.
 */
export async function isVerificationUnavailable(err: unknown): Promise<boolean> {
  const lib = await appleLibrary();
  if (err instanceof (lib.VerificationException as unknown as new (...a: never[]) => object)) {
    return (err as { status: unknown }).status === lib.VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;
  }
  // Anything the library did not classify — a raw fetch or DNS failure, a
  // timeout — is treated as unavailable rather than as a bad signature.
  return true;
}

/**
 * Verifies `signedTransaction` against Apple's certificate and reports whether
 * it grants access, plus the purchase's original transaction id.
 *
 * A signature or structure failure is a plain "not paid" — the request still
 * goes through the free tier. A failure to REACH Apple is reported as
 * `unavailable`, so the caller can fall back to a recent grant instead.
 *
 * The sandbox verifier is consulted only when explicitly allowed: sandbox
 * tester purchases are free, so accepting them in production hands anyone the
 * product.
 */
export async function isPaidTransaction(
  config: EntitlementConfig,
  bundleId: string,
  signedTransaction: string,
  now: number,
  log: (message: string, detail?: Record<string, unknown>) => void,
): Promise<PaidTransaction> {
  const lib = await appleLibrary();
  const roots = [...config.appleRootCertificates];

  const production = new lib.SignedDataVerifier(roots, true, lib.Environment.PRODUCTION, bundleId, config.appAppleId);
  const verifiers = [production];
  if (config.allowSandbox === true) {
    // Apple asks that appAppleId be omitted for sandbox.
    verifiers.push(new lib.SignedDataVerifier(roots, true, lib.Environment.SANDBOX, bundleId));
  }

  let unavailable = false;
  for (const verifier of verifiers) {
    try {
      const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
      return {
        paid: grantsAccess(config, transaction, bundleId, now),
        ...(transaction.originalTransactionId !== undefined
          ? { originalTransactionId: transaction.originalTransactionId }
          : {}),
      };
    } catch (err) {
      if (await isVerificationUnavailable(err)) {
        unavailable = true;
        log('entitlement verification unavailable', { name: (err as Error)?.name });
      }
      // Otherwise: signed for the other environment, or not Apple's signature.
    }
  }

  return unavailable ? { paid: false, unavailable: true } : { paid: false };
}
