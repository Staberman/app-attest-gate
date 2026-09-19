import { describe, expect, it } from 'vitest';
import { clientIp, countInWindow, releaseFromWindow, slidingEstimate } from '../src/window.js';
import { createMemoryStore } from '../src/stores/memory.js';

describe('slidingEstimate', () => {
  it('counts the whole previous bucket at the very start of a window', () => {
    expect(slidingEstimate(1, 10, 0)).toBe(11);
  });

  it('has forgotten the previous bucket by the end of the window', () => {
    expect(slidingEstimate(1, 10, 1)).toBe(1);
  });

  it('decays smoothly rather than resetting', () => {
    expect(slidingEstimate(0, 10, 0.25)).toBe(8);
    expect(slidingEstimate(0, 10, 0.5)).toBe(5);
    expect(slidingEstimate(0, 10, 0.75)).toBe(3);
  });

  it('never reads a fraction outside 0-1 as negative weight', () => {
    expect(slidingEstimate(1, 10, 1.5)).toBe(1);
    expect(slidingEstimate(1, 10, -1)).toBe(11);
  });
});

describe('countInWindow', () => {
  it('counts the request it is called for', async () => {
    const store = createMemoryStore();
    expect(await countInWindow(store, 's', 60, 0)).toBe(1);
    expect(await countInWindow(store, 's', 60, 0)).toBe(2);
  });

  it('carries the previous bucket into the next window', async () => {
    const store = createMemoryStore(() => 0);
    for (let i = 0; i < 5; i += 1) await countInWindow(store, 's', 60, 0);
    // One second into the following bucket: the five behind still weigh in.
    expect(await countInWindow(store, 's', 60, 61_000)).toBeGreaterThan(5);
  });

  it('gives a slot back on release', async () => {
    const store = createMemoryStore();
    await countInWindow(store, 's', 60, 0);
    await countInWindow(store, 's', 60, 0);
    await releaseFromWindow(store, 's', 60, 0);
    expect(await countInWindow(store, 's', 60, 0)).toBe(2);
  });
});

describe('clientIp', () => {
  it('takes the first entry of x-forwarded-for', () => {
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip', () => {
    expect(clientIp({ 'x-real-ip': '9.9.9.9' })).toBe('9.9.9.9');
  });

  it('does not throw when there is nothing to read', () => {
    expect(clientIp({})).toBe('unknown');
  });
});
