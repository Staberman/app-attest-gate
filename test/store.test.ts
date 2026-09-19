import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/stores/memory.js';
import type { AttestedKey } from '../src/types.js';

const key = (signCount: number): AttestedKey => ({
  publicKey: 'pk',
  signCount,
  environment: 'production',
  registeredAt: '2026-01-01T00:00:00.000Z',
});

describe('advanceSignCount — the replay defence', () => {
  it('moves the counter forward exactly once for a given value', async () => {
    const store = createMemoryStore();
    await store.saveKey('k', key(4), 60);

    // Two copies of the same captured assertion. Only one may win.
    const [first, second] = await Promise.all([store.advanceSignCount('k', 5), store.advanceSignCount('k', 5)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await store.loadKey('k'))!.signCount).toBe(5);
  });

  it('refuses a counter that went backwards', async () => {
    const store = createMemoryStore();
    await store.saveKey('k', key(9), 60);
    expect(await store.advanceSignCount('k', 8)).toBe(false);
    expect(await store.advanceSignCount('k', 9)).toBe(false);
    expect(await store.advanceSignCount('k', 10)).toBe(true);
  });

  it('refuses a key that was never registered', async () => {
    expect(await createMemoryStore().advanceSignCount('nobody', 1)).toBe(false);
  });

  it('keeps the rest of the record intact when it advances', async () => {
    const store = createMemoryStore();
    await store.saveKey('k', key(1), 60);
    await store.advanceSignCount('k', 2);
    expect(await store.loadKey('k')).toMatchObject({ publicKey: 'pk', environment: 'production', registeredAt: '2026-01-01T00:00:00.000Z' });
  });
});

describe('consumeChallenge', () => {
  it('returns true exactly once', async () => {
    const store = createMemoryStore();
    await store.setChallenge('c', 60);
    expect(await store.consumeChallenge('c')).toBe(true);
    expect(await store.consumeChallenge('c')).toBe(false);
  });

  it('returns false for a challenge nobody issued', async () => {
    expect(await createMemoryStore().consumeChallenge('made-up')).toBe(false);
  });

  it('expires', async () => {
    let clock = 0;
    const store = createMemoryStore(() => clock);
    await store.setChallenge('c', 10);
    clock = 11_000;
    expect(await store.consumeChallenge('c')).toBe(false);
  });
});

describe('claimPurchase — a JWS is a bearer token', () => {
  it('lets the same key re-claim its own purchase forever', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 20; i += 1) {
      expect(await store.claimPurchase('tx', 'key-a', 6, 60)).toBe(true);
    }
  });

  it('caps how many distinct installs one purchase entitles', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 6; i += 1) {
      expect(await store.claimPurchase('tx', `key-${i}`, 6, 60)).toBe(true);
    }
    expect(await store.claimPurchase('tx', 'key-7', 6, 60)).toBe(false);
  });

  it('does not let a burst of strangers all slip past the ceiling', async () => {
    const store = createMemoryStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_unused, i) => store.claimPurchase('tx', `key-${i}`, 6, 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(6);
  });
});
