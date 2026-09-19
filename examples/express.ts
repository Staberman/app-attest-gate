/**
 * Express. The whole integration.
 *
 * The one thing that is easy to get wrong: `express.json()` must NOT run on
 * the protected route. It consumes the stream, and the bytes the device signed
 * are gone by the time the gate sees them.
 */
import express from 'express';
import { Redis } from '@upstash/redis';
import { createGate, createUpstashStore, parseJson } from 'app-attest-gate';
import { readFileSync } from 'node:fs';

const gate = createGate({
  teamId: 'ABCDE12345',
  bundleId: 'com.example.app',
  store: createUpstashStore(Redis.fromEnv()),
  meter: { perKey: 10, windowDays: 7, perIpPerDay: 40 },
  rateLimit: { maxPerWindow: 10, windowSeconds: 60 },
  entitlement: {
    appAppleId: 1234567890,
    productIds: ['app_lifetime'],
    nonExpiringProductIds: ['app_lifetime'],
    appleRootCertificates: [readFileSync('certs/AppleRootCA-G3.cer')],
    // Leave this off in production: sandbox purchases are free.
    allowSandbox: process.env.ALLOW_SANDBOX === 'true',
  },
});

const app = express();

// --- registration: JSON is fine here, nothing is signed yet ---

app.post('/attest/challenge', express.json(), async (_req, res) => {
  res.json({ challenge: await gate.challenge() });
});

app.post('/attest/register', express.json(), async (req, res) => {
  const result = await gate.register(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// --- the protected route: raw body only ---

app.post('/organize', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const rawBody = req.body as Buffer;

  const access = await gate.resolve({
    headers: req.headers as Record<string, unknown>,
    rawBody,
    body: parseJson(rawBody),
  });

  if (!access.ok) {
    if (access.retryAfterSeconds) res.setHeader('retry-after', access.retryAfterSeconds);
    return res.status(access.status).json({ error: access.error });
  }

  try {
    const result = await doTheExpensiveThing(parseJson(rawBody));

    // Counted only now. A failure is not a unit, and a paying caller spends none.
    if (!access.paid) await gate.recordUnit(access.keyId);

    res.json(result);
  } catch (error) {
    // The work produced nothing, so give the network its slot back.
    if (!access.paid) await gate.releaseIpSlot(access.ip);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

declare function doTheExpensiveThing(body: unknown): Promise<unknown>;

app.listen(3000);
