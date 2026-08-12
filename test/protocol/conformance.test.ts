/**
 * Executes the shared protocol conformance corpus (protocol/vectors/codec),
 * mirroring the Dart runner at hoomi-flutter-microapp/test/protocol/
 * conformance_test.dart. Both SDKs run the same vectors so the two repos
 * cannot drift: adding a protocol method means adding a vector.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, decodeCallFrame } from '../../src/index.js';
import { MockHost } from '../../src/mock/index.js';

interface Vector {
  name: string;
  protocol: number;
  raw: string;
  expect:
    | { ok: true; id: string; method: string; epoch: number; params: Record<string, unknown> }
    | { ok: false; errorCode: string; id: string | null };
}

const vectorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'vectors', 'codec');
const files = readdirSync(vectorsDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const vectors: Array<[string, Vector]> = files.map((f) => [
  f,
  JSON.parse(readFileSync(join(vectorsDir, f), 'utf8')) as Vector,
]);

describe('protocol conformance corpus', () => {
  it('the corpus is present (drift alarm: do not let this list shrink)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  describe('decodeCallFrame (codec level, mirrors the Dart codec test)', () => {
    for (const [file, vector] of vectors) {
      it(`${file}: ${vector.name}`, () => {
        expect(vector.protocol).toBe(PROTOCOL_VERSION);
        const result = decodeCallFrame(vector.raw);
        if (vector.expect.ok) {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.call.id).toBe(vector.expect.id);
            expect(result.call.method).toBe(vector.expect.method);
            expect(result.call.epoch).toBe(vector.expect.epoch);
            expect(result.call.params).toEqual(vector.expect.params);
          }
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errorCode).toBe(vector.expect.errorCode);
            // expect.id is load-bearing: a recoverable id must be echoed so
            // the caller's promise settles; a hostile id must NOT be
            // reflected back (null).
            expect(result.id).toBe(vector.expect.id);
          }
        }
      });
    }
  });

  describe('MockHost end-to-end (failure vectors produce host-shaped error frames)', () => {
    for (const [file, vector] of vectors) {
      if (vector.expect.ok) continue; // ok-vectors carry the corpus nonce, not this session's
      it(`${file}: response frame echoes ${vector.expect.id === null ? 'no id' : `id ${vector.expect.id}`}`, async () => {
        const host = new MockHost();
        const raw = await host.handleCall(vector.raw);
        const frame = JSON.parse(raw) as { id: string; ok: boolean; error?: { code: string } };
        expect(frame.ok).toBe(false);
        expect(frame.error?.code).toBe((vector.expect as { errorCode: string }).errorCode);
        // The host answers with an empty id when the id must not be echoed.
        expect(frame.id).toBe(vector.expect.id ?? '');
        host.uninstall();
      });
    }
  });
});
