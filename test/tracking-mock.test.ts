/**
 * The mock host's side of background location tracking (protocol v1).
 *
 * Everything here goes through `hoomi.call()` so it asserts what the mock
 * *host* enforces, not what the typed wrappers pre-check. The mock must hold
 * the same line as the real host — same caps, same scope gates, same refusal
 * to replace a session that still has unread fixes — because a micro-app
 * developed against a more forgiving mock ships bugs the device then finds.
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

interface Page {
  fixes: Array<{ seq: number; latitude: number; longitude: number; isMocked: boolean }>;
  lastSeq: number;
  hasMore: boolean;
  droppedCount: number;
  state: string;
}

const start = async (t: TestHoomi, params: Record<string, unknown> = {}) =>
  (await t.hoomi.call('location.startTracking', params)) as { trackingId: string; resumed: boolean; state: string };
const read = async (t: TestHoomi, trackingId: string, afterSeq = 0) =>
  (await t.hoomi.call('location.readTrack', { trackingId, afterSeq })) as Page;
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof HoomiError ? e.code : `not a HoomiError: ${String(e)}`),
  );

describe('mock location tracking', () => {
  it('has recorded the three fixture fixes by the time start returns', async () => {
    const t = make();
    const { trackingId } = await start(t);
    const page = await read(t, trackingId);
    expect(page.fixes.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(page.fixes[0]).toMatchObject({ latitude: -6.2, longitude: 106.8, isMocked: false });
    expect(page).toMatchObject({ lastSeq: 3, hasMore: false, droppedCount: 0, state: 'active' });
  });

  it('pushTrackFix records a fix and announces it', async () => {
    const t = make();
    const { trackingId } = await start(t);
    const seen: unknown[] = [];
    t.hoomi.on('location.trackAvailable', (data) => seen.push(data));

    expect(t.host.pushTrackFix({ latitude: -6.3 })).toBe(4);

    const page = await read(t, trackingId, 3);
    expect(page.fixes).toHaveLength(1);
    expect(page.fixes[0]).toMatchObject({ seq: 4, latitude: -6.3 });
    expect(seen).toEqual([{ trackingId, lastSeq: 4 }]);
  });

  it('pushTrackFix throws when nothing is tracking', () => {
    const t = make();
    expect(() => t.host.pushTrackFix()).toThrow(/not tracking/i);
  });

  it('evicts the oldest unread fix when the buffer is full, and says so', async () => {
    const t = make({ limits: { maxTrackedFixes: 2 } });
    const { trackingId } = await start(t);
    const page = await read(t, trackingId);
    expect(page.fixes.map((f) => f.seq)).toEqual([2, 3]);
    expect(page.droppedCount).toBe(1);
  });

  it('hands back an expired session instead of replacing it', async () => {
    const t = make();
    const first = await start(t);
    t.host.expireTracking();

    expect((await read(t, first.trackingId)).state).toBe('expired');
    const again = await start(t);
    expect(again).toMatchObject({ trackingId: first.trackingId, resumed: true, state: 'expired' });
    expect(() => t.host.pushTrackFix()).toThrow(/not tracking/i);
  });

  it('reports a failed location source', async () => {
    const t = make();
    const { trackingId } = await start(t);
    t.host.failTracking();
    expect((await read(t, trackingId)).state).toBe('failed');
  });

  it('requires the location.background scope', async () => {
    const t = make();
    t.host.revoke('location.background');
    expect(await codeOf(t.hoomi.call('location.startTracking', {}))).toBe('E_SCOPE_DENIED');
  });

  it('requires location.fine for high accuracy, on every location method', async () => {
    const t = make();
    t.host.revoke('location.fine');
    expect(await codeOf(t.hoomi.call('location.startTracking', { accuracy: 'high' }))).toBe('E_SCOPE_DENIED');
    expect(await codeOf(t.hoomi.call('location.getCurrent', { accuracy: 'high' }))).toBe('E_SCOPE_DENIED');
    expect(
      await codeOf(t.hoomi.call('bridge.subscribe', { method: 'location.watch', params: { accuracy: 'high' } })),
    ).toBe('E_SCOPE_DENIED');
    // The legacy value is not "high": it keeps working without the scope.
    expect(await codeOf(t.hoomi.call('location.getCurrent', { accuracy: 'fine' }))).toBe('OK');
  });

  it('surfaces a permanently denied OS permission', async () => {
    const t = make({ permissions: { location: 'denied_forever' } });
    expect(await codeOf(t.hoomi.call('location.startTracking', {}))).toBe('E_PERMISSION_DENIED_FOREVER');
  });

  it('keeps the session across a page reload', async () => {
    const t = make();
    const { trackingId } = await start(t);
    t.host.setEpoch(2, true);
    await new Promise((r) => setTimeout(r, 0));
    expect((await read(t, trackingId)).fixes).toHaveLength(3);
  });

  it('reset() ends tracking', async () => {
    const t = make();
    await start(t);
    t.host.reset();
    expect(() => t.host.pushTrackFix()).toThrow(/not tracking/i);
  });
});

describe('mock ui.setKeepScreenOn', () => {
  it('records the request and forgets it on reset', async () => {
    const t = make();
    expect(t.host.keepScreenOn).toBe(false);
    await t.hoomi.call('ui.setKeepScreenOn', { enabled: true });
    expect(t.host.keepScreenOn).toBe(true);
    t.host.reset();
    expect(t.host.keepScreenOn).toBe(false);
  });
});
