import { afterEach, describe, expect, it } from 'vitest';

import type { LaunchPayload } from '../src/index.js';
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

describe('launch payload replay', () => {
  it('onLoad fires for a subscriber registered long after lifecycle.load arrived', async () => {
    const { hoomi } = make({ launchParams: { table: '12', promo: 'WELCOME10' } });
    await hoomi.ready();
    await sleep(20); // load + show already delivered by now
    const seen: LaunchPayload[] = [];
    hoomi.onLoad((p) => seen.push(p)); // the "React mounted too late" case
    await sleep(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual({ table: '12', promo: 'WELCOME10' });
    expect(hoomi.launchPayload?.params).toEqual({ table: '12', promo: 'WELCOME10' });
  });

  it('onShow fires after load; onHide/unload after lifecycle.close', async () => {
    const { hoomi } = make();
    const events: string[] = [];
    hoomi.onShow(() => events.push('show'));
    hoomi.onHide(() => events.push('hide'));
    hoomi.on('lifecycle.unload', () => events.push('unload'));
    await hoomi.ready();
    await sleep(20);
    expect(events).toEqual(['show']);
    await hoomi.lifecycle.close();
    await sleep(20);
    expect(events).toEqual(['show', 'hide', 'unload']);
  });

  it('onError receives host-side error events', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const seen: Array<[string, unknown]> = [];
    hoomi.onError((message, data) => seen.push([message, data]));
    host.emit('lifecycle.error', { message: 'renderer crashed', fatal: true });
    await sleep(10);
    expect(seen).toEqual([['renderer crashed', { message: 'renderer crashed', fatal: true }]]);
  });

  it('lifecycle.ready and reportError reach the host', async () => {
    const { hoomi, host } = make();
    await hoomi.lifecycle.ready();
    await hoomi.lifecycle.reportError('something broke');
    const methods = host.calls.map((c) => c.method);
    expect(methods).toContain('lifecycle.ready');
    expect(methods).toContain('lifecycle.reportError');
    const report = host.calls.find((c) => c.method === 'lifecycle.reportError');
    expect(report?.params).toEqual({ message: 'something broke' });
  });
});

describe('back press', () => {
  it('a handler returning true acks handled before the grace timeout', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    hoomi.onBackPress(() => true);
    await expect(host.pressBack()).resolves.toEqual({ handled: true, timedOut: false });
  });

  it('with no handlers the SDK acks unhandled promptly (no grace timeout burn)', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const start = Date.now();
    await expect(host.pressBack()).resolves.toEqual({ handled: false, timedOut: false });
    expect(Date.now() - start).toBeLessThan(300); // did not wait out the 350ms grace
  });

  it('handlers run newest-first and stop at the first true', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const order: string[] = [];
    hoomi.onBackPress(() => {
      order.push('old');
      return false;
    });
    hoomi.onBackPress(async () => {
      order.push('new');
      return true;
    });
    await expect(host.pressBack()).resolves.toEqual({ handled: true, timedOut: false });
    expect(order).toEqual(['new']);
  });

  it('an unregistered handler no longer participates', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const off = hoomi.onBackPress(() => true);
    off();
    await expect(host.pressBack()).resolves.toEqual({ handled: false, timedOut: false });
  });

  it('a handler slower than the grace timeout counts as unhandled (timedOut)', async () => {
    const { hoomi, host } = make({ limits: { backPressGraceMs: 60 } });
    await hoomi.ready();
    hoomi.onBackPress(async () => {
      await sleep(200);
      return true;
    });
    await expect(host.pressBack()).resolves.toEqual({ handled: false, timedOut: true });
  });

  it('a throwing handler counts as not-handled and does not break others', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    hoomi.onBackPress(() => true);
    hoomi.onBackPress(() => {
      throw new Error('oops'); // newest, runs first, must not stop the chain
    });
    await expect(host.pressBack()).resolves.toEqual({ handled: true, timedOut: false });
  });
});

describe('scope change notifications', () => {
  it('onScopesChanged delivers the updated scope list', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();
    const snapshots: string[][] = [];
    hoomi.onScopesChanged((scopes) => snapshots.push([...scopes]));
    host.revoke('ble', 'iot');
    await sleep(10);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).not.toContain('ble');
    expect(snapshots[0]).not.toContain('iot');
    expect(snapshots[0]).toContain('wallet');
  });
});
