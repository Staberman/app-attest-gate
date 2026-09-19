import { describe, expect, it } from 'vitest';
import { grantsAccess } from '../src/entitlement.js';
import type { EntitlementConfig } from '../src/types.js';

const CONFIG = {
  appAppleId: 123,
  productIds: ['app_monthly', 'app_lifetime'],
  nonExpiringProductIds: ['app_lifetime'],
  appleRootCertificates: [],
} satisfies EntitlementConfig;

const BUNDLE = 'com.example.app';
const NOW = 1_700_000_000_000;

describe('grantsAccess', () => {
  it('grants a lifetime product with no expiry', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_lifetime' }, BUNDLE, NOW)).toBe(true);
  });

  it('grants a subscription that has not expired', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_monthly', expiresDate: NOW + 1000 }, BUNDLE, NOW)).toBe(true);
  });

  it('refuses a subscription that has expired', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_monthly', expiresDate: NOW - 1 }, BUNDLE, NOW)).toBe(false);
  });

  it('treats a subscription with NO expiry as inactive, not as forever', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_monthly' }, BUNDLE, NOW)).toBe(false);
  });

  it('refuses a refunded or revoked family share, even for a lifetime product', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_lifetime', revocationDate: NOW - 1 }, BUNDLE, NOW)).toBe(false);
  });

  it('refuses a transaction for another app', () => {
    expect(grantsAccess(CONFIG, { bundleId: 'com.someone.else', productId: 'app_lifetime' }, BUNDLE, NOW)).toBe(false);
  });

  it('refuses a product that is not on the list', () => {
    expect(grantsAccess(CONFIG, { bundleId: BUNDLE, productId: 'app_consumable_coins' }, BUNDLE, NOW)).toBe(false);
  });
});
