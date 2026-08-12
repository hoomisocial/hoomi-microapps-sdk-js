import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  HoomiError,
  PROTOCOL_VERSION,
  decodeInboundFrame,
  encodeCallFrame,
  encodeFrame,
  utf8ByteLength,
} from '../src/index.js';

const callFrame = (params: unknown) =>
  encodeCallFrame({ v: PROTOCOL_VERSION, id: 'c-1', type: 'call', method: 'storage.set', params, n: 'nonce', e: 1 });

describe('codec round-trips', () => {
  const cases: Array<[string, unknown]> = [
    ['emoji', { s: 'hello 😀🇮🇩 world' }],
    ['surrogate pair', { s: '𝌆𐍈' }],
    ['U+2028/U+2029 line separators', { s: 'a\u2028b\u2029c' }],
    ['lone surrogate', { s: '\uD800 and \uDFFF' }],
    ['empty string', { s: '' }],
    ['newlines and controls', { s: 'a\nb\r\tc\0' }],
    ['nested structures', { a: [1, 2.5, -3], b: { c: null, d: [true, false] }, e: 'ok' }],
  ];

  for (const [name, data] of cases) {
    it(`round-trips ${name}`, () => {
      const raw = encodeFrame({ v: 1, id: 'c-9', type: 'result', ok: true, data });
      const decoded = decodeInboundFrame(raw);
      expect(decoded.type).toBe('result');
      expect(decoded.type === 'result' && decoded.data).toEqual(data);
    });
  }

  it('encoded frames are always a single line (no raw newlines or line separators)', () => {
    const raw = callFrame({ s: 'a\nb c d\re' });
    expect(raw).not.toMatch(/[\n\r\u2028\u2029]/);
  });

  it('round-trips event frames including sub and error', () => {
    const raw = encodeFrame({
      v: 1,
      type: 'event',
      event: 'stream.error',
      sub: 's-3',
      error: { code: 'E_UNAVAILABLE', message: 'gps off', retryable: true },
    });
    const decoded = decodeInboundFrame(raw);
    expect(decoded.type).toBe('event');
    if (decoded.type === 'event') {
      expect(decoded.event).toBe('stream.error');
      expect(decoded.sub).toBe('s-3');
      expect(decoded.error?.code).toBe('E_UNAVAILABLE');
    }
  });
});

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('a€😀')).toBe(8);
  });

  it('boundary sizes: exactly-at-cap passes the comparison, one over fails', () => {
    const cap = 64;
    const exactly = 'x'.repeat(cap);
    const over = 'x'.repeat(cap - 3) + '😀'; // 4-byte char pushes it to cap+1
    expect(utf8ByteLength(exactly)).toBe(cap);
    expect(utf8ByteLength(exactly) <= cap).toBe(true);
    expect(utf8ByteLength(over)).toBe(cap + 1);
    expect(utf8ByteLength(over) <= cap).toBe(false);
  });
});

describe('codec properties (fast-check)', () => {
  const anyString = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' }));

  it('arbitrary unicode strings survive encode/decode exactly', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const raw = encodeFrame({ v: 1, id: 'c-1', type: 'result', ok: true, data: { s } });
        expect(raw).not.toMatch(/[\n\r\u2028\u2029]/);
        const decoded = decodeInboundFrame(raw);
        expect(decoded.type === 'result' && (decoded.data as { s: string }).s).toBe(s);
      }),
      { numRuns: 300 },
    );
  });

  it('arbitrary JSON payloads survive encode/decode', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (data) => {
        const raw = encodeFrame({ v: 1, id: 'c-1', type: 'result', ok: true, data });
        const decoded = decodeInboundFrame(raw);
        // Compare against JSON semantics (e.g. -0 normalises to 0).
        expect(decoded.type === 'result' && decoded.data).toEqual(JSON.parse(JSON.stringify(data ?? null)));
      }),
      { numRuns: 300 },
    );
  });

  it('call frames with arbitrary params always stay single-line valid JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (params) => {
        const raw = callFrame(params);
        expect(raw).not.toMatch(/[\n\r\u2028\u2029]/);
        const parsed = JSON.parse(raw) as { id: string; n: string; e: number };
        expect(parsed.id).toBe('c-1');
        expect(parsed.n).toBe('nonce');
        expect(parsed.e).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe('decode rejects malformed frames with E_PROTOCOL', () => {
  const bad: Array<[string, string]> = [
    ['not JSON', '{nope'],
    ['not an object', '"hi"'],
    ['wrong version', JSON.stringify({ v: 2, id: 'c-1', type: 'result', ok: true })],
    ['unknown type', JSON.stringify({ v: 1, type: 'call?' })],
    ['result without id', JSON.stringify({ v: 1, type: 'result', ok: true })],
    ['result with invalid id', JSON.stringify({ v: 1, id: 'bad id!', type: 'result', ok: true })],
    ['result with 65-char id', JSON.stringify({ v: 1, id: 'a'.repeat(65), type: 'result', ok: true })],
    ['result without ok', JSON.stringify({ v: 1, id: 'c-1', type: 'result' })],
    ['event without event name', JSON.stringify({ v: 1, type: 'event' })],
  ];
  for (const [name, raw] of bad) {
    it(name, () => {
      try {
        decodeInboundFrame(raw);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HoomiError);
        expect((err as HoomiError).code).toBe('E_PROTOCOL');
      }
    });
  }

  it('failure result with malformed error object degrades to E_INTERNAL wire error', () => {
    const decoded = decodeInboundFrame(JSON.stringify({ v: 1, id: 'c-1', type: 'result', ok: false, error: 42 }));
    expect(decoded.type === 'result' && decoded.error?.code).toBe('E_INTERNAL');
  });
});
