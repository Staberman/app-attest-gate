import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, parseJson, rawBodyFromRequest, readRawBody } from '../src/rawBody.js';

const stream = (...chunks: (string | Buffer)[]): IncomingMessage =>
  Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))) as unknown as IncomingMessage;

describe('readRawBody', () => {
  it('returns the bytes exactly as they arrived, across chunks', async () => {
    expect((await readRawBody(stream('{"a":', '1}'))).toString()).toBe('{"a":1}');
  });

  it('preserves byte-level detail a re-serialisation would lose', async () => {
    // Odd spacing and key order are exactly what JSON.stringify(parsed) destroys,
    // and exactly what the signature covers.
    const odd = '{ "b":2,  "a" : 1 }';
    expect((await readRawBody(stream(odd))).toString()).toBe(odd);
  });

  it('handles an empty body', async () => {
    expect((await readRawBody(stream())).length).toBe(0);
  });

  it('preserves multi-byte UTF-8 split across chunk boundaries', async () => {
    const text = Buffer.from('{"t":"ñandú"}', 'utf8');
    const cut = 9; // lands inside the ñ
    const body = await readRawBody(stream(text.subarray(0, cut), text.subarray(cut)));
    expect(body.equals(text)).toBe(true);
  });

  it('uses a preserved rawBody rather than a stream someone already drained', async () => {
    const drained = Object.assign(stream(), { rawBody: Buffer.from('kept') });
    expect((await readRawBody(drained)).toString()).toBe('kept');
  });

  it('accepts a preserved rawBody that a framework stored as a string', async () => {
    const drained = Object.assign(stream(), { rawBody: '{"a":1}' });
    expect((await readRawBody(drained)).toString()).toBe('{"a":1}');
  });

  it('refuses to buffer more than the limit from an unauthenticated caller', async () => {
    // The signature has not been checked yet at this point, so this limit is
    // the only thing between you and someone streaming forever.
    await expect(readRawBody(stream('x'.repeat(100)), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('rawBodyFromRequest', () => {
  it('reads a standard Request', async () => {
    const body = await rawBodyFromRequest(new Request('https://x.test', { method: 'POST', body: '{"a":1}' }));
    expect(body.toString()).toBe('{"a":1}');
  });

  it('enforces the limit too', async () => {
    const request = new Request('https://x.test', { method: 'POST', body: 'x'.repeat(100) });
    await expect(rawBodyFromRequest(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('parseJson', () => {
  it('parses what it can', () => {
    expect(parseJson(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it('returns undefined rather than throwing on junk', () => {
    expect(parseJson(Buffer.from('not json'))).toBeUndefined();
  });
});
