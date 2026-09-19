/**
 * Vercel serverless function, or a Next.js pages-API route.
 *
 * `bodyParser: false` is the load-bearing line. Without it Vercel parses the
 * body, the stream is drained, and every assertion fails.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';
import { createGate, createUpstashStore, parseJson, readRawBody, BodyTooLargeError } from 'app-attest-gate';
import { readFileSync } from 'node:fs';

export const config = { api: { bodyParser: false } };

const gate = createGate({
  teamId: 'ABCDE12345',
  bundleId: 'com.example.app',
  store: createUpstashStore(Redis.fromEnv()),
  meter: { perKey: 10, windowDays: 7, perIpPerDay: 40 },
  entitlement: {
    appAppleId: 1234567890,
    productIds: ['app_lifetime'],
    nonExpiringProductIds: ['app_lifetime'],
    appleRootCertificates: [readFileSync('certs/AppleRootCA-G3.cer')],
  },
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return res.status(413).json({ error: 'Body too large' });
    throw error;
  }

  const access = await gate.resolve({ headers: req.headers, rawBody, body: parseJson(rawBody) });

  if (!access.ok) {
    if (access.retryAfterSeconds) res.setHeader('retry-after', String(access.retryAfterSeconds));
    return res.status(access.status).json({ error: access.error });
  }

  const result = await doTheExpensiveThing(parseJson(rawBody));
  if (!access.paid) await gate.recordUnit(access.keyId);

  res.json(result);
}

declare function doTheExpensiveThing(body: unknown): Promise<unknown>;
