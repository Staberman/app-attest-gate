# Security

This package sits on an authentication path. If you find a vulnerability in it,
please do not open a public issue.

**Report it to lautaro@staberman.com.ar.** Include what you found, how to
reproduce it, and what it lets an attacker do. You will get an answer within a
few days.

## Scope

In scope: anything that lets a caller pass the gate without a valid assertion,
replay an assertion, bypass the free-tier meter, or claim a purchase that is
not theirs.

Out of scope: the cryptography itself, which belongs to
[`node-app-attest`](https://github.com/uebelack/node-app-attest) and
[`@apple/app-store-server-library`](https://github.com/apple/app-store-server-library-node)
— report those upstream.

## Known limits, by design

- **Per-IP ceilings rest on `x-forwarded-for`, which a client can forge.** They
  are only as trustworthy as the proxy in front of you, which must overwrite
  the header rather than append to it.
- **A custom `GateStore` whose `advanceSignCount` or `claimPurchase` is not
  atomic reopens the races those methods exist to close.** The bundled Upstash
  adapter uses Lua scripts; anything else is your responsibility to get right.
- **A purchase JWS is a bearer token.** The 6-key cap bounds how far a leaked
  one spreads; it does not prevent sharing.
