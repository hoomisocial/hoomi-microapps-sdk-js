/**
 * Page-side behaviour of the typed `location` and `ui.setKeepScreenOn`
 * wrappers: what they translate, what they leave alone, and what they refuse
 * to put on the wire. The host contract itself is pinned by the vectors in
 * protocol/vectors/methods/.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HoomiError } from '../src/index.js';
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

const sent = (t: TestHoomi, method: string) => t.host.calls.filter((c) => c.method === method).map((c) => c.params);

async function expectRejectedBeforeTheWire(t: TestHoomi, method: string, attempt: Promise<unknown>): Promise<void> {
  const err = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HoomiError);
  expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
  expect(sent(t, method)).toEqual([]);
}

describe('location params', () => {
  it('sends the deprecated minDistanceM as minDistanceMeters', async () => {
    const t = make();
    const sub = await t.hoomi.location.watch({ minDistanceM: 10 }, () => {});
    const subscribe = sent(t, 'bridge.subscribe')[0] as { params: Record<string, unknown> };
    expect(subscribe.params).toEqual({ minDistanceMeters: 10 });
    await sub.close();
  });

  it('prefers minDistanceMeters when both are given', async () => {
    const t = make();
    const sub = await t.hoomi.location.watch({ minDistanceM: 10, minDistanceMeters: 5 }, () => {});
    const subscribe = sent(t, 'bridge.subscribe')[0] as { params: Record<string, unknown> };
    expect(subscribe.params).toEqual({ minDistanceMeters: 5 });
    await sub.close();
  });

  it("leaves the legacy 'fine' accuracy exactly as the app wrote it", async () => {
    const t = make();
    await t.hoomi.location.getCurrent({ accuracy: 'fine' });
    expect(sent(t, 'location.getCurrent')).toEqual([{ accuracy: 'fine' }]);
  });

  it("sends 'high' for precise fixes", async () => {
    const t = make();
    await t.hoomi.location.getCurrent({ accuracy: 'high' });
    expect(sent(t, 'location.getCurrent')).toEqual([{ accuracy: 'high' }]);
  });
});

describe('tracking raw methods', () => {
  it('start, read and stop round-trip', async () => {
    const t = make();
    const session = await t.hoomi.location.startTracking({ accuracy: 'high', minDistanceMeters: 10 });
    expect(session).toMatchObject({ resumed: false, state: 'active' });

    const page = await t.hoomi.location.readTrack({ trackingId: session.trackingId });
    expect(page.fixes.map((f) => f.seq)).toEqual([1, 2, 3]);

    expect(await t.hoomi.location.stopTracking(session.trackingId)).toBeUndefined();
  });

  it('rejects malformed params before they reach the wire', async () => {
    const t = make();
    const { location } = t.hoomi;
    await expectRejectedBeforeTheWire(t, 'location.startTracking', location.startTracking({ minDistanceMeters: 1.5 }));
    await expectRejectedBeforeTheWire(t, 'location.startTracking', location.startTracking({ minDistanceMeters: -1 }));
    await expectRejectedBeforeTheWire(
      t,
      'location.startTracking',
      location.startTracking({ accuracy: 'fine' as never }),
    );
    await expectRejectedBeforeTheWire(t, 'location.readTrack', location.readTrack({ trackingId: '' }));
    await expectRejectedBeforeTheWire(t, 'location.readTrack', location.readTrack({ trackingId: 'trk-1', limit: 0 }));
    await expectRejectedBeforeTheWire(t, 'location.readTrack', location.readTrack({ trackingId: 'trk-1', limit: 501 }));
    await expectRejectedBeforeTheWire(
      t,
      'location.readTrack',
      location.readTrack({ trackingId: 'trk-1', afterSeq: -1 }),
    );
    await expectRejectedBeforeTheWire(t, 'location.stopTracking', location.stopTracking(''));
  });
});

describe('ui.setKeepScreenOn', () => {
  it('sends the flag', async () => {
    const t = make();
    await t.hoomi.ui.setKeepScreenOn(true);
    expect(t.host.keepScreenOn).toBe(true);
    await t.hoomi.ui.setKeepScreenOn(false);
    expect(t.host.keepScreenOn).toBe(false);
  });

  it('rejects a non-boolean before it reaches the wire', async () => {
    const t = make();
    await expectRejectedBeforeTheWire(t, 'ui.setKeepScreenOn', t.hoomi.ui.setKeepScreenOn('yes' as never));
  });
});
