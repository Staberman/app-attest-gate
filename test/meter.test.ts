import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/stores/memory.js';
import { recordUnit, unitsUsed } from '../src/meter.js';
import type { MeterConfig } from '../src/types.js';

const WEEK: MeterConfig = { perKey: 10, windowDays: 7 };
const DAY_MS = 86_400_000;

describe('the free tier is counted in day buckets, not a sliding estimate', () => {
  it('sums the trailing window', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 3; i += 1) await recordUnit(store, WEEK, 'k', 0);
    expect(await unitsUsed(store, WEEK, 'k', 0)).toBe(3);
  });

  it('reports what it just recorded without a second round trip', async () => {
    const store = createMemoryStore();
    expect(await recordUnit(store, WEEK, 'k', 0)).toBe(1);
    expect(await recordUnit(store, WEEK, 'k', 0)).toBe(2);
  });

  it('still counts a unit spent six days ago', async () => {
    const store = createMemoryStore();
    await recordUnit(store, WEEK, 'k', 0);
    expect(await unitsUsed(store, WEEK, 'k', 6 * DAY_MS)).toBe(1);
  });

  it('lets a unit fall out of the window on the seventh day', async () => {
    const store = createMemoryStore();
    await recordUnit(store, WEEK, 'k', 0);
    expect(await unitsUsed(store, WEEK, 'k', 7 * DAY_MS)).toBe(0);
  });

  it('does not bound the error to more than a day either way', async () => {
    // Ten spent at once cannot read as more than ten anywhere in the window,
    // which is exactly what the two-bucket estimate got wrong at week scale.
    const store = createMemoryStore();
    for (let i = 0; i < 10; i += 1) await recordUnit(store, WEEK, 'k', 0);
    for (let day = 0; day < 7; day += 1) {
      expect(await unitsUsed(store, WEEK, 'k', day * DAY_MS)).toBe(10);
    }
  });

  it('keeps keys apart', async () => {
    const store = createMemoryStore();
    await recordUnit(store, WEEK, 'a', 0);
    expect(await unitsUsed(store, WEEK, 'b', 0)).toBe(0);
  });
});
