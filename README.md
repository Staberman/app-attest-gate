# app-attest-gate

[![CI](https://github.com/Staberman/app-attest-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/Staberman/app-attest-gate/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/app-attest-gate?style=flat-square&color=CB3837)](https://www.npmjs.com/package/app-attest-gate)

A Node/TypeScript library that lets your server prove a request came from a genuine, unmodified copy of your iOS app — and, separately, that the caller actually paid.

It is the parts of Apple App Attest that everyone hand-rolls and usually gets wrong, plus the StoreKit 2 pairing nobody ships at all.

```sh
npm install app-attest-gate
```

## The iOS side

**[AppAttestClient](https://github.com/Staberman/app-attest-client)** is the Swift half: a Secure Enclave signer that speaks exactly these headers, with the concurrent-registration race already handled. Use either alone — they agree on the wire format, they do not depend on each other.

## This is not another attestation verifier

[`node-app-attest`](https://www.npmjs.com/package/node-app-attest) already verifies attestations and assertions, it does it well, and **this package uses it**. What it deliberately leaves to you is everything around the crypto:

> *"You are responsible for storing challenges, persisting the sign count, and hashing the request body."*

That list is the hard part. Getting any of it subtly wrong leaves you with a server that looks protected and is not:

| What | Done wrong | What it costs you |
|---|---|---|
| **Sign-count advance** | read, compare, write | Two copies of one captured assertion both read the old counter, both pass, both go through. **No replay protection at all.** |
| **Re-registration** | overwrite the key record | The counter resets to zero and every assertion ever captured becomes valid again. |
| **Environment check** | only at registration | Turning off development attestations does not revoke the keys that registered while it was on. |
| **Body hashing** | `JSON.stringify(req.body)` | Not byte-identical to what the device signed. Every signature fails, or worse, you stop checking. |
| **Challenges** | reusable, or never expiring | A captured registration replays forever. |

This package does those five things, and then meters what the caller may spend.

## What it gives you

```ts
import { createGate, createUpstashStore } from 'app-attest-gate';
import { Redis } from '@upstash/redis';

const gate = createGate({
  teamId: 'ABCDE12345',
  bundleId: 'com.example.app',
  store: createUpstashStore(Redis.fromEnv()),

  // Optional: meter a free tier on the server, where the user cannot edit it.
  meter: { perKey: 10, windowDays: 7, perIpPerDay: 40 },

  // Optional: let a verified App Store purchase lift the meter.
  entitlement: {
    appAppleId: 1234567890,
    productIds: ['app_monthly', 'app_lifetime'],
    nonExpiringProductIds: ['app_lifetime'],
    appleRootCertificates: [readFileSync('AppleRootCA-G3.cer')],
  },

  rateLimit: { maxPerWindow: 10, windowSeconds: 60 },
});
```

Two endpoints for registration:

```ts
// POST /attest/challenge — issuing a challenge is a write
return Response.json({ challenge: await gate.challenge() });

// POST /attest/register
const result = await gate.register({ keyId, challenge, attestation });
```

Then one call on every request that matters:

```ts
const access = await gate.resolve({ headers: req.headers, rawBody, body });
if (!access.ok) return new Response(access.error, { status: access.status });

const result = await doTheWork();

// Counted AFTER the work succeeded — a failure is not a unit.
if (!access.paid) await gate.recordUnit(access.keyId);

// And if the work produced nothing, give the network its slot back:
//   if (!access.paid) await gate.releaseIpSlot(access.ip);
```

`access.status` is already the right one: `401` unauthenticated, `402` free tier spent, `429` rate limited, `503` store unreachable.

## Getting `rawBody` right

This is where App Attest breaks for most people, and it fails in a way that looks like a cryptography problem: every signature is rejected, so they conclude the library is wrong and stop checking.

The assertion covers a SHA-256 of the body **as sent**. Once a framework has parsed it, those bytes are gone — `JSON.stringify(req.body)` is a different string the moment the client's encoder ordered keys differently, spaced differently, or escaped a character differently. One byte is enough.

So capture the raw body before any parser touches it, which means turning the parser off on these routes:

**Express**

```ts
import { readRawBody, parseJson } from 'app-attest-gate';

// No body parser on this route. express.json() above it would consume the stream.
app.post('/organize', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body as Buffer;      // express.raw leaves it a Buffer
  const access = await gate.resolve({ headers: req.headers, rawBody, body: parseJson(rawBody) });
  ...
});
```

**Vercel / Next.js pages API**

```ts
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const rawBody = await readRawBody(req);
  const access = await gate.resolve({ headers: req.headers, rawBody, body: parseJson(rawBody) });
  ...
}
```

**Anything built on fetch** — Workers, Deno, Bun, Next.js route handlers

```ts
import { rawBodyFromRequest, parseJson } from 'app-attest-gate';

export async function POST(request: Request) {
  const rawBody = await rawBodyFromRequest(request);   // a body reads only once
  const headers = Object.fromEntries(request.headers);
  const access = await gate.resolve({ headers, rawBody, body: parseJson(rawBody) });
  ...
}
```

Both readers take a `maxBytes` limit, one megabyte by default. The signature has not been checked yet at that point, so it is the only thing between you and an unauthenticated caller streaming forever.

Complete, runnable versions of all three are in [`examples/`](examples).


## The StoreKit pairing

This is the part that does not exist anywhere else.

StoreKit 2 hands your app a transaction signed by Apple. Forward it in `x-transaction-jws` and the gate verifies it against Apple's root certificate — so the *server* decides who has paid, and a free tier can live somewhere the user cannot edit.

Three things it gets right that a naive check does not:

**A refund ends access, a missing expiry does not extend it.** A revoked family share and a subscription with no `expiresDate` both read as unpaid, rather than as forever.

**"Apple is unreachable" is not "you did not pay."** The verifier does live OCSP checks. When those fail, the library reports it as retryable — and reading that as a bad signature bills your paying customers a free unit during an outage on Apple's side. The gate distinguishes the two and falls back to a cached grant for 24 hours.

**A purchase JWS is a bearer token.** Anyone holding it can present it, and with no user accounts there is nothing to tie it to a person. One purchase is capped at 6 install keys — enough for reinstalls and a Family Sharing group, not for the hundreds of strangers a leaked token would otherwise entitle. The claim is atomic, so a burst cannot all slip past the cap at once.

## Should you use Firebase App Check instead?

**Quite possibly.** It is free on both Spark and Blaze plans, it works with a custom backend (your server verifies an RS256 JWT with the Admin SDK — you are not forced onto Firestore), and it has replay protection through limited-use tokens.

Use this package instead when:

- **you do not want Google in your trust path.** The chain here is Apple-only.
- **you do not want a network round trip per request.** App Check's replay protection is a beta RPC to Google on every call; here it is one atomic operation against your own store.
- **you need the request itself signed.** App Check attests the *app*. It does not sign *this specific payload*. The assertion here covers the exact bytes of the body, so a valid token cannot be lifted onto a different request.
- **you want entitlement metering.** Entirely outside App Check's scope.

## Storage

The gate needs somewhere to keep challenges, keys, counters and meters that survives a cold start and is shared between instances.

`createUpstashStore(redis)` is bundled and takes any client with `get/set/del/incr/decr/expire/eval`. `createMemoryStore()` exists for tests and local development — **never production**: a serverless function loses it on every cold start, and two instances do not share it, which means no replay protection.

Writing your own is a ten-method interface. Two of those methods, `advanceSignCount` and `claimPurchase`, **must be atomic** — they are Lua scripts in the bundled adapter. Implemented as read-then-write they each reopen the exact race they exist to close.

## Requirements

Node 18+, **ESM only** — `import`, not `require`. `@apple/app-store-server-library` is an optional peer dependency, loaded only if you configure `entitlement`.

## Credits

The attestation and assertion cryptography is [`node-app-attest`](https://github.com/uebelack/node-app-attest) by David Übelacker. Transaction verification is [`@apple/app-store-server-library`](https://github.com/apple/app-store-server-library-node). This package is the state machine between them.

Extracted from a shipping iOS app.

## License

MIT
