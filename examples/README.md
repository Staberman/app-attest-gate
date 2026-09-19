# Examples

Three complete integrations. Each one is the whole story: the two registration
endpoints, the protected route, and where the free unit is counted.

| File | Runtime |
|---|---|
| [`express.ts`](express.ts) | Express 4/5 on Node |
| [`vercel.ts`](vercel.ts) | Vercel serverless functions / Next.js pages API |
| [`fetch.ts`](fetch.ts) | Cloudflare Workers, Deno, Bun, Next.js route handlers |

They are not compiled or tested in CI — they import packages this one does not
depend on. Read them as reference, not as a build target.
