/**
 * Wallet payload contract (protocol v1).
 *
 * These assertions are about the *shape* of the money path, which is where
 * this SDK and the Dart host had silently diverged: the SDK was sending
 * {amount, currency, orderId} and reading {paymentId, status} while the host
 * required {amountMinor, currency, payeeRef}. Every wallet call failed.
 *
 * The corresponding wire-level vectors live in protocol/vectors/methods/ and
 * are run by test/protocol/methods.test.ts against the mock host; what is
 * covered here is the page-side behaviour of the typed wrappers.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HoomiError, type PaymentResult, type PaymentStatus } from '../src/index.js';
import { createTestHoomi, type TestHoomi } from '../src/testing/index.js';

let active: TestHoomi[] = [];
const make = (...args: Parameters<typeof createTestHoomi>): TestHoomi => {
  const t = createTestHoomi(...args);
  active.push(t);
  return t;
};

afterEach(() => {
  for (const t of active) t.cleanup();
  active = [];
});

const walletCalls = (host: TestHoomi['host']) => host.calls.filter((c) => c.method.startsWith('wallet.'));

describe('wallet.requestPayment params', () => {
  it('rejects a fractional amountMinor BEFORE it reaches the wire', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();

    // TypeScript cannot express "integer", so 2500.5 type-checks fine. That is
    // exactly why the runtime guard has to exist.
    const err = await hoomi.wallet
      .requestPayment({ amountMinor: 2500.5, currency: 'IDR', payeeRef: 'merchant:88' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    expect((err as HoomiError).message).toContain('amountMinor');
    // The point of validating page-side: no frame was ever written. A float
    // that reaches the host is a float that can be truncated on a money path.
    expect(walletCalls(host)).toEqual([]);
    expect(host.frames.filter((f) => f.frame.includes('wallet.requestPayment'))).toEqual([]);
  });

  it('rejects a non-integer amount however it is spelled, and never sends it', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const bad: unknown[] = [2500.5, Number.NaN, Number.POSITIVE_INFINITY, '2500', null, undefined, 0, -1, 1e308 * 10];
    for (const amountMinor of bad) {
      const err = await hoomi.wallet
        .requestPayment({ amountMinor, currency: 'IDR', payeeRef: 'merchant:88' } as never)
        .catch((e: unknown) => e);
      expect((err as HoomiError).code, `amountMinor=${String(amountMinor)}`).toBe('E_INVALID_PARAMS');
    }
    expect(walletCalls(host)).toEqual([]);
  });

  it('requires payeeRef — an orderId is not a substitute for it', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();

    const err = await hoomi.wallet
      // @ts-expect-error — payeeRef is required in the type as well.
      .requestPayment({ amountMinor: 250_000, currency: 'IDR', orderId: 'o-42' })
      .catch((e: unknown) => e);

    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    expect((err as HoomiError).message).toContain('payeeRef');
    expect(walletCalls(host)).toEqual([]);
  });

  it('requires a currency', async () => {
    const { hoomi } = make();
    const err = await hoomi.wallet
      // @ts-expect-error — currency is required in the type as well.
      .requestPayment({ amountMinor: 250_000, payeeRef: 'merchant:88' })
      .catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
  });

  it('sends amountMinor/currency/payeeRef verbatim, orderId optional', async () => {
    const { hoomi, host } = make();
    await hoomi.wallet.requestPayment({
      amountMinor: 250_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
      orderId: 'o-42',
      description: '2x flat white',
    });
    const call = host.calls.find((c) => c.method === 'wallet.requestPayment');
    expect(call?.params).toEqual({
      amountMinor: 250_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
      orderId: 'o-42',
      description: '2x flat white',
    });
  });
});

describe('wallet.getBalance params', () => {
  it('requires an explicit currency and never guesses one', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    // @ts-expect-error — currency is required.
    const err = await hoomi.wallet.getBalance().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    expect(walletCalls(host)).toEqual([]);
  });

  it('answers with integer minor units in the requested currency', async () => {
    const { hoomi, host } = make();
    const balance = await hoomi.wallet.getBalance({ currency: 'IDR' });
    expect(Number.isSafeInteger(balance.amountMinor)).toBe(true);
    expect(balance.currency).toBe('IDR');
    expect(balance).not.toHaveProperty('amount');
    expect(host.calls.find((c) => c.method === 'wallet.getBalance')?.params).toEqual({ currency: 'IDR' });
  });
});

describe('wallet payment status', () => {
  it('an unrecognised status string does not throw — it is passed through', async () => {
    const { hoomi, host } = make();
    // A newer host settles a payment as something this SDK version has never
    // heard of. Forward compatibility means the call resolves and the caller
    // decides, not that the SDK rejects on an unknown enum member.
    host.on('wallet.requestPayment', () => ({
      paymentId: 'pay-future-1',
      status: 'settling_via_qris',
      amountMinor: 250_000,
      currency: 'IDR',
    }));

    const payment = await hoomi.wallet.requestPayment({
      amountMinor: 250_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
    });
    expect(payment.status).toBe('settling_via_qris');

    // ...and the same on the status query path.
    host.on('wallet.getPaymentStatus', () => ({ paymentId: 'pay-future-1', status: 'refunded' }));
    const status = await hoomi.wallet.getPaymentStatus({ paymentId: 'pay-future-1' });
    expect(status.status).toBe('refunded');

    // Type-level: an unknown string is assignable to PaymentStatus, so
    // narrowing on the three known members stays possible without a cast.
    const s: PaymentStatus = payment.status;
    expect(typeof s).toBe('string');
  });

  it('the v1 union is pending | succeeded | failed', () => {
    const statuses: PaymentStatus[] = ['pending', 'succeeded', 'failed'];
    expect(statuses).toHaveLength(3);
    // `completed`, `authorized` and `refunded` are gone from v1: no host
    // implements them. They still type-check via the open-ended arm, which is
    // the whole point — an old string is data, not a crash.
    const legacy: PaymentStatus = 'completed';
    expect(legacy).toBe('completed');
  });

  it('PaymentResult carries the amount back, not an idempotency key', async () => {
    const { hoomi } = make();
    const payment: PaymentResult = await hoomi.wallet.requestPayment({
      amountMinor: 250_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
      orderId: 'o-42',
    });
    expect(payment).toMatchObject({
      status: 'succeeded',
      amountMinor: 250_000,
      currency: 'IDR',
      orderId: 'o-42',
    });
    expect(typeof payment.paymentId).toBe('string');
    expect(Object.keys(payment).sort()).toEqual(['amountMinor', 'currency', 'orderId', 'paymentId', 'status']);
  });

  it('getPaymentStatus requires a paymentId', async () => {
    const { hoomi } = make();
    // @ts-expect-error — paymentId is required.
    const err = await hoomi.wallet.getPaymentStatus({}).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
  });
});
