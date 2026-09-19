import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cryptography belongs to node-app-attest and is its business to test.
 * What is mocked here is a *successful* verification, so the state machine
 * around it — challenges, the counter, the environment check — is what the
 * assertions actually exercise.
 */
const verifyAttestation = vi.fn();
const verifyAssertion = vi.fn();
vi.mock('node-app-attest', () => ({
  verifyAttestation: (...args: unknown[]) => verifyAttestation(...args),
  verifyAssertion: (...args: unknown[]) => verifyAssertion(...args),
}));

const { createGate } = await import('../src/gate.js');
const { createMemoryStore } = await import('../src/stores/memory.js');
const { HEADERS } = await import('../src/types.js');

const BODY = Buffer.from('{"text":"hello"}');

function headers(extra: Record<string, string> = {}) {
  return { [HEADERS.keyId]: 'key-1', [HEADERS.assertion]: 'sig', ...extra };
}

function gate(overrides: Record<string, unknown> = {}) {
  return createGate({
    teamId: 'TEAM123456',
    bundleId: 'com.example.app',
    store: createMemoryStore(),
    log: () => {},
    ...overrides,
  } as never);
}

beforeEach(() => {
  verifyAttestation.mockReset();
  verifyAssertion.mockReset();
  verifyAttestation.mockReturnValue({ publicKey: 'pk', environment: 'production' });
});

async function registered(g: ReturnType<typeof gate>) {
  const challenge = await g.challenge();
  const result = await g.register({ keyId: 'key-1', challenge, attestation: 'att' });
  expect(result.ok).toBe(true);
  return g;
}

describe('challenges', () => {
  it('accepts a challenge exactly once', async () => {
    const g = gate();
    const challenge = await g.challenge();
    expect((await g.register({ keyId: 'key-1', challenge, attestation: 'a' })).ok).toBe(true);
    const replay = await g.register({ keyId: 'key-2', challenge, attestation: 'a' });
    expect(replay).toMatchObject({ ok: false, error: 'Unknown or expired challenge' });
  });

  it('refuses a challenge nobody issued, before doing any certificate work', async () => {
    const g = gate();
    expect(await g.register({ keyId: 'k', challenge: 'invented', attestation: 'a' })).toMatchObject({ ok: false });
    expect(verifyAttestation).not.toHaveBeenCalled();
  });
});

describe('replay protection', () => {
  it('lets a request through once and refuses the identical capture', async () => {
    const g = await registered(gate());
    verifyAssertion.mockReturnValue({ signCount: 1 });

    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true, keyId: 'key-1' });
    // The very same bytes and the very same counter, replayed.
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({
      ok: false,
      status: 401,
      error: 'Assertion already used',
    });
  });

  it('accepts the next counter value', async () => {
    const g = await registered(gate());
    verifyAssertion.mockReturnValueOnce({ signCount: 1 }).mockReturnValueOnce({ signCount: 2 });
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true });
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true });
  });

  it('re-registering a known key does NOT reset its counter', async () => {
    const g = await registered(gate());
    verifyAssertion.mockReturnValue({ signCount: 7 });
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true });

    // Register again with a fresh challenge, as a reinstall would.
    const challenge = await g.challenge();
    expect(await g.register({ keyId: 'key-1', challenge, attestation: 'att' })).toMatchObject({ ok: true, created: false });

    // A zeroed counter here would make every assertion captured at 1..7 valid again.
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: false, error: 'Assertion already used' });
  });

  it('passes the raw bytes to the verifier, not a re-serialised body', async () => {
    const g = await registered(gate());
    verifyAssertion.mockReturnValue({ signCount: 1 });
    await g.resolve({ headers: headers(), rawBody: BODY });
    expect(verifyAssertion.mock.calls[0]![0]).toMatchObject({ payload: BODY });
  });
});

describe('environment pinning', () => {
  it('rejects a development key on every request once the flag goes off', async () => {
    const store = createMemoryStore();
    verifyAttestation.mockReturnValue({ publicKey: 'pk', environment: 'development' });

    const permissive = gate({ store, allowDevelopmentEnvironment: true });
    await registered(permissive);
    verifyAssertion.mockReturnValue({ signCount: 1 });
    expect(await permissive.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true });

    // Same store, same registered key — only the flag changed.
    const strict = gate({ store });
    expect(await strict.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({
      ok: false,
      status: 401,
      error: 'Key environment not allowed',
    });
  });
});

describe('the free tier', () => {
  const meter = { perKey: 2, windowDays: 7 };

  it('lets a key through until its allowance is spent', async () => {
    const g = await registered(gate({ meter }));
    let count = 0;
    verifyAssertion.mockImplementation(() => ({ signCount: (count += 1) }));

    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true, unitsUsed: 0 });
    await g.recordUnit('key-1');
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true, unitsUsed: 1 });
    await g.recordUnit('key-1');
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: false, status: 402, error: 'Free limit reached' });
  });

  it('caps free usage per network, and reports it as a rate limit not a spent tier', async () => {
    const g = await registered(gate({ meter: { ...meter, perIpPerDay: 1 } }));
    let count = 0;
    verifyAssertion.mockImplementation(() => ({ signCount: (count += 1) }));
    const from = headers({ 'x-forwarded-for': '203.0.113.9' });

    expect(await g.resolve({ headers: from, rawBody: BODY })).toMatchObject({ ok: true });
    expect(await g.resolve({ headers: from, rawBody: BODY })).toMatchObject({ ok: false, status: 429 });
  });
});

describe('freshness', () => {
  it('refuses a stale body when a skew window is configured', async () => {
    const g = await registered(gate({ maxClockSkewMs: 60_000 }));
    verifyAssertion.mockReturnValue({ signCount: 1 });
    const stale = { sentAt: new Date(Date.now() - 600_000).toISOString() };
    expect(await g.resolve({ headers: headers(), rawBody: BODY, body: stale })).toMatchObject({ ok: false, error: 'Request is stale' });
  });

  it('does not require sentAt when no skew window is configured', async () => {
    const g = await registered(gate());
    verifyAssertion.mockReturnValue({ signCount: 1 });
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: true });
  });
});

describe('missing credentials', () => {
  it('refuses a request with no key id or assertion', async () => {
    const g = gate();
    expect(await g.resolve({ headers: {}, rawBody: BODY })).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an assertion for a key that was never registered', async () => {
    const g = gate();
    expect(await g.resolve({ headers: headers(), rawBody: BODY })).toMatchObject({ ok: false, status: 401, error: 'Unknown key' });
  });
});
