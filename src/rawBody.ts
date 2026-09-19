import type { IncomingMessage } from 'node:http';

/**
 * Reading the bytes the device actually signed.
 *
 * This is the single most common way App Attest is broken, and it fails in a
 * way that looks like a cryptography problem: every signature is rejected, so
 * people conclude the library is wrong and stop checking.
 *
 * The assertion covers a SHA-256 of the request body **as sent**. Once a
 * framework has parsed that body into an object, those bytes are gone —
 * `JSON.stringify(req.body)` is a different string whenever the client's
 * encoder ordered keys differently, spaced differently, or escaped a character
 * differently. One byte is enough.
 *
 * So the raw body has to be captured BEFORE any parser touches it, which means
 * turning the parser off for the routes the gate protects.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeded ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Collects a Node request stream into a Buffer.
 *
 * Only works if nothing has consumed the stream first. In Express that means
 * `express.raw()` on this route, or no body parser mounted above it; on Vercel
 * it means exporting `export const config = { api: { bodyParser: false } }`.
 *
 * `maxBytes` bounds what an unauthenticated caller can make you buffer — the
 * signature has not been checked yet at this point, so the limit is the only
 * thing standing between you and someone streaming forever.
 */
export async function readRawBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BYTES): Promise<Buffer> {
  // Some frameworks stash the untouched bytes; use them rather than a stream
  // that has already been drained.
  const preserved = (req as IncomingMessage & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(preserved)) return preserved;
  if (typeof preserved === 'string') return Buffer.from(preserved);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

/**
 * The same thing for a standard `Request` — Cloudflare Workers, Deno, Bun,
 * Next.js route handlers, anything built on fetch.
 *
 * Clone the request first if you also need to parse it: a body can only be
 * read once.
 */
export async function rawBodyFromRequest(request: Request, maxBytes = DEFAULT_MAX_BYTES): Promise<Buffer> {
  const buffer = Buffer.from(await request.arrayBuffer());
  if (buffer.length > maxBytes) throw new BodyTooLargeError(maxBytes);
  return buffer;
}

/**
 * Parses bytes you already captured, so the gate and your handler agree about
 * what the request said. Returns `undefined` rather than throwing: a body that
 * is not JSON is the caller's problem to report, not this function's.
 */
export function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}
