/**
 * Anything built on fetch: Cloudflare Workers, Deno, Bun, Next.js route
 * handlers.
 *
 * A `Request` body reads exactly once. Read it as bytes and parse from those,
 * rather than calling `.json()` and losing them.
 */
import { Redis } from '@upstash/redis';
import { createGate, createUpstashStore, parseJson, rawBodyFromRequest } from 'app-attest-gate';

const gate = createGate({
  teamId: 'ABCDE12345',
  bundleId: 'com.example.app',
  store: createUpstashStore(Redis.fromEnv()),
  meter: { perKey: 10, windowDays: 7 },
});

export async function POST(request: Request): Promise<Response> {
  const rawBody = await rawBodyFromRequest(request);
  const headers = Object.fromEntries(request.headers);

  const access = await gate.resolve({ headers, rawBody, body: parseJson(rawBody) });

  if (!access.ok) {
    return Response.json(
      { error: access.error },
      {
        status: access.status,
        headers: access.retryAfterSeconds ? { 'retry-after': String(access.retryAfterSeconds) } : undefined,
      },
    );
  }

  const result = await doTheExpensiveThing(parseJson(rawBody));
  if (!access.paid) await gate.recordUnit(access.keyId);

  return Response.json(result);
}

declare function doTheExpensiveThing(body: unknown): Promise<unknown>;
