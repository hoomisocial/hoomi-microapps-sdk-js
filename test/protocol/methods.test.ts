/**
 * Executes the per-method conformance corpus (protocol/vectors/methods).
 *
 * The codec corpus pins the envelope; this one pins what is *inside* params
 * and result. Envelope-only coverage is exactly why the wallet payloads in
 * this SDK and in the Dart host drifted into two incompatible shapes while
 * every test stayed green.
 *
 * Vectors go through `hoomi.call()` — the untyped escape hatch — on purpose:
 * this asserts the host contract, not the typed wrappers. The wrappers' own
 * page-side validation is covered in test/wallet.test.ts.
 *
 * Format: protocol/vectors/methods/README.md.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { HoomiError, PROTOCOL_VERSION } from '../../src/index.js';
import { createTestHoomi, type TestHoomi } from '../../src/testing/index.js';

type JsonType = 'string' | 'number' | 'boolean';

interface SetupCall {
  method: string;
  params: Record<string, unknown>;
  /** result key -> binding name, referenced later as "$name". */
  bind?: Record<string, string>;
}

interface Vector {
  name: string;
  protocol: number;
  method: string;
  params: Record<string, unknown>;
  setup?: SetupCall[];
  expect:
    | { ok: true; result?: Record<string, unknown>; resultTypes?: Record<string, JsonType> }
    | { ok: false; errorCode: string; errorData?: Record<string, unknown> };
}

const vectorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'vectors', 'methods');
const files = readdirSync(vectorsDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const vectors: Array<[string, Vector]> = files.map((f) => [
  f,
  JSON.parse(readFileSync(join(vectorsDir, f), 'utf8')) as Vector,
]);

/** Substitutes exactly-"$name" string values; no interpolation, by design. */
function bindParams(params: Record<string, unknown>, bindings: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const name = value.slice(1);
      if (!bindings.has(name)) throw new Error(`vector references unbound "$${name}"`);
      out[key] = bindings.get(name);
    } else {
      out[key] = value;
    }
  }
  return out;
}

let active: TestHoomi[] = [];

afterEach(() => {
  for (const t of active) t.cleanup();
  active = [];
});

describe('per-method conformance corpus', () => {
  it('the corpus is present (drift alarm: do not let this list shrink)', () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
  });

  it('covers all three wallet methods', () => {
    const methods = new Set(vectors.map(([, v]) => v.method));
    expect([...methods].sort()).toEqual(['wallet.getBalance', 'wallet.getPaymentStatus', 'wallet.requestPayment']);
  });

  for (const [file, vector] of vectors) {
    it(`${file}: ${vector.name}`, async () => {
      expect(vector.protocol).toBe(PROTOCOL_VERSION);

      // A fresh host per vector: no vector may depend on another's ordering
      // or on a balance another vector already spent.
      const t = createTestHoomi();
      active.push(t);
      const { hoomi } = t;

      const bindings = new Map<string, unknown>();
      for (const step of vector.setup ?? []) {
        const result = (await hoomi.call(step.method, bindParams(step.params, bindings))) as Record<string, unknown>;
        for (const [resultKey, bindName] of Object.entries(step.bind ?? {})) {
          bindings.set(bindName, result[resultKey]);
        }
      }

      const params = bindParams(vector.params, bindings);
      const outcome = await hoomi
        .call(vector.method, params)
        .then((result) => ({ ok: true as const, result: result as Record<string, unknown> }))
        .catch((err: unknown) => ({ ok: false as const, err }));

      // The vector must have been answered by the host. Without this, a
      // page-side guard could satisfy an E_INVALID_PARAMS expectation while
      // the host itself happily accepted the payload — which is the exact
      // failure mode this corpus exists to catch.
      expect(
        t.host.calls.some((c) => c.method === vector.method),
        `${vector.method} never reached the host`,
      ).toBe(true);

      if (vector.expect.ok) {
        if (!outcome.ok) {
          throw new Error(
            `expected success, got ${(outcome.err as HoomiError).code}: ${(outcome.err as Error).message}`,
          );
        }
        if (vector.expect.result) expect(outcome.result).toMatchObject(vector.expect.result);
        for (const [key, type] of Object.entries(vector.expect.resultTypes ?? {})) {
          expect(typeof outcome.result[key], `result.${key}`).toBe(type);
        }
      } else {
        expect(outcome.ok, `expected ${vector.expect.errorCode}, call succeeded`).toBe(false);
        if (outcome.ok) return;
        const err = outcome.err;
        expect(err).toBeInstanceOf(HoomiError);
        expect((err as HoomiError).code).toBe(vector.expect.errorCode);
        if (vector.expect.errorData) {
          expect((err as HoomiError).data).toMatchObject(vector.expect.errorData);
        }
      }
    });
  }
});
