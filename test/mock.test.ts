import { afterEach, describe, expect, it } from 'vitest';

import {
  BridgeUnavailableError,
  HoomiError,
  PermissionDeniedError,
  RateLimitedError,
  ScopeNotGrantedError,
  UserCancelledError,
  utf8ByteLength,
} from '../src/index.js';
import { MockHost, mockError } from '../src/mock/index.js';
import { createTestHoomi, type TestHoomi } from '../src/testing/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe('happy path built-ins', () => {
  it('storage round-trips JSON values including unicode', async () => {
    const { hoomi } = make();
    await hoomi.storage.set('greeting', { text: 'halo 🌏 dunia' });
    expect(await hoomi.storage.get('greeting')).toEqual({ text: 'halo 🌏 dunia' });
    expect(await hoomi.storage.get('missing')).toBeNull();
    await hoomi.storage.set('n', 42);
    expect((await hoomi.storage.keys()).sort()).toEqual(['greeting', 'n']);
    await hoomi.storage.remove('n');
    expect(await hoomi.storage.keys()).toEqual(['greeting']);
    await hoomi.storage.clear();
    expect(await hoomi.storage.keys()).toEqual([]);
  });

  it('profile, system info, network, confirm', async () => {
    const { hoomi } = make({ user: { displayName: 'Aftah' } });
    const profile = await hoomi.user.getProfile();
    expect(profile.displayName).toBe('Aftah');
    const info = await hoomi.system.getInfo();
    expect(info.platform).toBe('android');
    expect(await hoomi.system.getNetworkStatus()).toMatchObject({ online: true });
    expect(await hoomi.ui.confirm('sure?')).toBe(true);
    await hoomi.ui.toast('hi'); // string convenience form
  });

  it('payment flow: pay, balance decremented, status queryable', async () => {
    const { hoomi } = make();
    const before = await hoomi.wallet.getBalance({ currency: 'IDR' });
    const payment = await hoomi.wallet.requestPayment({
      amountMinor: 250_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
      orderId: 'o-1',
    });
    expect(payment.status).toBe('succeeded');
    const after = await hoomi.wallet.getBalance({ currency: 'IDR' });
    expect(after.amountMinor).toBe(before.amountMinor - 250_000);
    const status = await hoomi.wallet.getPaymentStatus({ paymentId: payment.paymentId });
    expect(status).toMatchObject({
      paymentId: payment.paymentId,
      status: 'succeeded',
      amountMinor: 250_000,
      currency: 'IDR',
      orderId: 'o-1',
    });
  });

  it('the payment result never carries a host-internal idempotency key', async () => {
    const { hoomi } = make();
    const payment = await hoomi.wallet.requestPayment({
      amountMinor: 1_000,
      currency: 'IDR',
      payeeRef: 'merchant:88',
    });
    expect(payment).not.toHaveProperty('idempotencyKey');
    expect(payment).not.toHaveProperty('reference');
    expect(payment).not.toHaveProperty('payeeRef');
  });

  it('rejects an invalid payment with E_INVALID_PARAMS', async () => {
    const { hoomi } = make();
    const err = await hoomi.wallet
      .requestPayment({ amountMinor: -5, currency: 'IDR', payeeRef: 'merchant:88', orderId: 'o-2' })
      .catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
  });

  it('insufficient balance is E_UNAVAILABLE carrying balance and requested', async () => {
    const { hoomi } = make();
    const err = await hoomi.wallet
      .requestPayment({ amountMinor: 999_999_999, currency: 'IDR', payeeRef: 'merchant:88' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as HoomiError).data).toMatchObject({ balance: 12_500_000, requested: 999_999_999 });
  });

  it('jobs schedule/list/cancel', async () => {
    const { hoomi } = make();
    const { jobId } = await hoomi.jobs.schedule({ name: 'sync', delayMs: 60_000 });
    expect((await hoomi.jobs.list()).jobs.map((j) => j.jobId)).toContain(jobId);
    await hoomi.jobs.cancel({ jobId });
    expect((await hoomi.jobs.list()).jobs).toEqual([]);
  });

  it('ble read/write require a connection (E_UNAVAILABLE otherwise)', async () => {
    const { hoomi } = make();
    const device = await hoomi.ble.requestDevice();
    const params = { deviceId: device.deviceId, service: 'svc', characteristic: 'chr' };
    const err = await hoomi.ble.read(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    await hoomi.ble.connect({ deviceId: device.deviceId });
    const read = await hoomi.ble.read(params);
    expect(read.value).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
    await hoomi.ble.write({ ...params, value: 'AQI=' });
    await hoomi.ble.disconnect({ deviceId: device.deviceId });
  });

  it('unknown methods are E_UNSUPPORTED, never a silent no-op', async () => {
    const { hoomi } = make();
    const err = await hoomi.call('nfc.readTag', {}).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_UNSUPPORTED');
  });
});

describe('scenarios', () => {
  it('deny-all: permission errors are retryable-style (permanent=false)', async () => {
    const { hoomi } = make({ scenario: 'deny-all' });
    const err = await hoomi.location.getCurrent().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permanent).toBe(false);
    expect((err as PermissionDeniedError).code).toBe('E_PERMISSION_DENIED');
  });

  it('deny-forever: permanent=true drives the Open Settings UI', async () => {
    const { hoomi } = make({ scenario: 'deny-forever' });
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permanent).toBe(true);
    expect((err as PermissionDeniedError).code).toBe('E_PERMISSION_DENIED_FOREVER');
  });

  it('cancel-everything: interactive flows are E_USER_DENIED, confirm resolves false', async () => {
    const { hoomi } = make({ scenario: 'cancel-everything' });
    const err = await hoomi.wallet
      .requestPayment({ amountMinor: 1, currency: 'IDR', payeeRef: 'merchant:88' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    expect(await hoomi.ui.confirm('delete everything?')).toBe(false);
  });

  it('no-scopes: everything scoped fails with ScopeNotGrantedError', async () => {
    const { hoomi } = make({ scenario: 'no-scopes' });
    const err = await hoomi.user.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeNotGrantedError);
    // Unscoped namespaces still work.
    await hoomi.storage.set('k', 1);
  });

  it('offline: network methods fail E_UNAVAILABLE, network status reports offline', async () => {
    const { hoomi } = make({ scenario: 'offline' });
    expect(await hoomi.system.getNetworkStatus()).toMatchObject({ online: false });
    const err = await hoomi.wallet.getBalance({ currency: 'IDR' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
  });

  it('rate-limited: burst of 3, then RateLimitedError with retryAfterMs', async () => {
    const { hoomi } = make({ scenario: 'rate-limited' });
    await hoomi.system.getInfo();
    await hoomi.system.getInfo();
    await hoomi.system.getInfo();
    const err = await hoomi.system.getInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBeGreaterThan(0);
  });

  it('slow-3g: calls take at least the configured latency', async () => {
    const { hoomi, host } = make();
    host.delay(60, 0);
    const start = Date.now();
    await hoomi.system.getInfo();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it('failureRate=1 makes calls fail with retryable E_INTERNAL', async () => {
    const { hoomi } = make({ failureRate: 1 });
    const err = await hoomi.system.getInfo().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INTERNAL');
    expect((err as HoomiError).retryable).toBe(true);
  });
});

describe('host constraints (the mock must not be nicer than the real host)', () => {
  it('payload cap is enforced end to end: client pre-checks after hello', async () => {
    const { hoomi } = make({ limits: { maxPayloadBytes: 512 } });
    await hoomi.ready();
    const err = await hoomi.storage.set('big', 'x'.repeat(2000)).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_PAYLOAD_TOO_LARGE');
  });

  it('payload cap is enforced host-side BEFORE parsing, with an empty id', async () => {
    const host = new MockHost({ limits: { maxPayloadBytes: 128 } });
    const big = JSON.stringify({ v: 1, id: 'c-1', type: 'call', method: 'ui.toast', params: { m: 'x'.repeat(500) }, n: 'whatever', e: 1 });
    expect(utf8ByteLength(big)).toBeGreaterThan(128);
    const response = JSON.parse(await host.handleCall(big)) as { id: string; ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('E_PAYLOAD_TOO_LARGE');
    expect(response.id).toBe(''); // rejected pre-parse: id never recovered
    host.uninstall();
  });

  it('subscription quota: exceeding maxSubscriptions rejects, closing frees a slot', async () => {
    const { hoomi, host } = make({ limits: { maxSubscriptions: 2 } });
    const nothing = {};
    const s1 = await hoomi.location.watch({ minIntervalMs: 5_000 }, nothing);
    const s2 = await hoomi.location.watch({ minIntervalMs: 5_000 }, nothing);
    const err = await hoomi.location.watch({ minIntervalMs: 5_000 }, nothing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(host.activeSubscriptionCount).toBe(2);
    await s1.close();
    const s3 = await hoomi.location.watch({ minIntervalMs: 5_000 }, nothing);
    await s2.close();
    await s3.close();
    expect(host.activeSubscriptionCount).toBe(0);
  });

  it('a wrong nonce is rejected with E_PROTOCOL and recorded as a violation', async () => {
    const host = new MockHost();
    const raw = JSON.stringify({ v: 1, id: 'c-1', type: 'call', method: 'ui.toast', params: { message: 'x' }, n: 'stolen-nonce', e: 1 });
    const response = JSON.parse(await host.handleCall(raw)) as { ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('E_PROTOCOL');
    expect(host.violations.length).toBe(1);
    host.uninstall();
  });

  it('setEpoch makes the SDK stale (E_STALE_EPOCH) until the bump is announced', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    host.setEpoch(2); // silent bump: SDK still sends e=1
    const err = await hoomi.system.getInfo().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_STALE_EPOCH');
    host.setEpoch(3, true); // announced: event carries e=3, SDK adopts it
    await sleep(10);
    expect(hoomi.epoch).toBe(3);
    await expect(hoomi.system.getInfo()).resolves.toBeTruthy();
  });
});

describe('handle API', () => {
  it('on() overrides a method; mockError() fails it with a specific code', async () => {
    const { hoomi, host } = make();
    host.on('camera.scanCode', (params) => ({ text: `scanned:${JSON.stringify(params)}`, format: 'qr' }));
    expect((await hoomi.camera.scanCode({ formats: ['qr'] })).text).toContain('scanned:');
    host.on('user.getIdToken', () => {
      throw mockError('E_UNAUTHENTICATED', 'session expired');
    });
    const err = await hoomi.user.getIdToken().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_UNAUTHENTICATED');
  });

  it('fail() forces a method to a code until removed', async () => {
    const { hoomi, host } = make();
    const undo = host.fail('wallet.getBalance', 'E_UNAVAILABLE');
    await expect(hoomi.wallet.getBalance({ currency: 'IDR' })).rejects.toBeInstanceOf(BridgeUnavailableError);
    undo();
    await expect(hoomi.wallet.getBalance({ currency: 'IDR' })).resolves.toMatchObject({ currency: 'IDR' });
  });

  it('waitFor resolves with the recorded call (past or future)', async () => {
    const { hoomi, host } = make();
    const waiting = host.waitFor('ui.toast');
    await hoomi.ui.toast('ping');
    const call = await waiting;
    expect(call.method).toBe('ui.toast');
    expect(call.params).toEqual({ message: 'ping' });
    // Already-recorded calls resolve immediately.
    await expect(host.waitFor('ui.toast', { timeoutMs: 10 })).resolves.toMatchObject({ method: 'ui.toast' });
  });

  it('grant/revoke push lifecycle.scopesChanged and update hoomi.scopes', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    expect(hoomi.hasScope('wallet')).toBe(true);
    host.revoke('wallet');
    await sleep(10);
    expect(hoomi.hasScope('wallet')).toBe(false);
    await expect(hoomi.wallet.getBalance({ currency: 'IDR' })).rejects.toBeInstanceOf(ScopeNotGrantedError);
    host.grant('wallet');
    await sleep(10);
    expect(hoomi.hasScope('wallet')).toBe(true);
  });

  it('setPermission drives the retry/settings distinction at runtime', async () => {
    const { hoomi, host } = make();
    host.setPermission('location', 'denied');
    let err = await hoomi.location.getCurrent().catch((e: unknown) => e);
    expect((err as PermissionDeniedError).permanent).toBe(false);
    host.setPermission('location', 'denied_forever');
    err = await hoomi.location.getCurrent().catch((e: unknown) => e);
    expect((err as PermissionDeniedError).permanent).toBe(true);
    host.setPermission('location', 'granted');
    await expect(hoomi.location.getCurrent()).resolves.toMatchObject({ latitude: expect.any(Number) });
  });

  it('frames log records in/out/push traffic; reset clears state', async () => {
    const { hoomi, host } = make();
    await hoomi.ui.toast('x');
    await sleep(10); // the lifecycle.load push is a macrotask after hello
    expect(host.frames.some((f) => f.dir === 'in')).toBe(true);
    expect(host.frames.some((f) => f.dir === 'out')).toBe(true);
    expect(host.frames.some((f) => f.dir === 'push')).toBe(true); // lifecycle.load
    await hoomi.storage.set('k', 1);
    host.reset();
    expect(host.frames).toHaveLength(0);
    expect(host.calls).toHaveLength(0);
  });

  it('custom stream drivers via onStream', async () => {
    const { hoomi, host } = make();
    host.onStream('iot.readTelemetry', (_params, stream) => {
      stream.data({ temperatureC: 21 });
      stream.done();
      return undefined;
    });
    const got: unknown[] = [];
    let completed = false;
    await hoomi.subscribe('iot.readTelemetry', { deviceId: 'iot-lamp-1' }, {
      next: (d) => got.push(d),
      complete: () => {
        completed = true;
      },
    });
    await sleep(10);
    expect(got).toEqual([{ temperatureC: 21 }]);
    expect(completed).toBe(true);
  });
});
