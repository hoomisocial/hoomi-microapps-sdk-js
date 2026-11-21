/**
 * `hoomi.location.track()` — the wrapper that turns the host's pull-based
 * track log into "here is every fix, in order".
 *
 * The cases that matter are the ones a page cannot see happening: it was
 * asleep and missed the hint, it reloaded, its own callback threw, the
 * session ended underneath it. In each, no fix may be skipped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HoomiError, type TrackedFix } from '../src/index.js';
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

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const countOf = (t: TestHoomi, method: string) => t.host.calls.filter((c) => c.method === method).length;

/** Starts tracking and waits for the three fixture fixes to be delivered. */
async function startTracked(t: TestHoomi, extra: Parameters<TestHoomi['hoomi']['location']['track']>[2] = {}) {
  const seqs: number[] = [];
  const errors: HoomiError[] = [];
  let completed = 0;
  const handle = await t.hoomi.location.track(
    undefined,
    {
      next: (fix: TrackedFix) => seqs.push(fix.seq),
      error: (err) => errors.push(err),
      complete: () => {
        completed += 1;
      },
    },
    extra,
  );
  await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3]));
  return { handle, seqs, errors, completed: () => completed };
}

describe('location.track', () => {
  it('delivers recorded fixes in order, then live ones', async () => {
    const t = make();
    const { handle, seqs } = await startTracked(t);
    expect(handle.resumed).toBe(false);

    t.host.pushTrackFix();
    await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3, 4]));
  });

  it('accepts a bare function as the observer', async () => {
    const t = make();
    const seqs: number[] = [];
    await t.hoomi.location.track({ accuracy: 'high' }, (fix) => seqs.push(fix.seq));
    await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3]));
  });

  it('catches up when the page comes back, even if every hint was lost', async () => {
    const t = make();
    const { seqs } = await startTracked(t);

    // The page is "asleep": reads fail, so the hint leads nowhere.
    const wake = t.host.fail('location.readTrack', 'E_INTERNAL');
    for (let i = 0; i < 5; i++) t.host.pushTrackFix();
    await tick(10);
    expect(seqs).toEqual([1, 2, 3]);

    wake();
    t.host.emit('lifecycle.show', {});
    await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('pages through a long backlog without skipping or repeating', async () => {
    const t = make();
    const { seqs } = await startTracked(t);
    const reads = countOf(t, 'location.readTrack');

    const wake = t.host.fail('location.readTrack', 'E_INTERNAL');
    for (let i = 0; i < 450; i++) t.host.pushTrackFix();
    await tick(10);
    wake();
    t.host.emit('lifecycle.show', {});

    await vi.waitFor(() => expect(seqs).toHaveLength(453));
    expect(seqs).toEqual(Array.from({ length: 453 }, (_, i) => i + 1));
    expect(countOf(t, 'location.readTrack') - reads).toBeGreaterThanOrEqual(3);
  });

  it('keeps delivering after the observer throws', async () => {
    const t = make();
    const seqs: number[] = [];
    await t.hoomi.location.track(undefined, (fix) => {
      seqs.push(fix.seq);
      if (fix.seq === 2) throw new Error('page bug');
    });
    await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3]));
  });

  it('re-attaches after a reload and receives everything not yet acknowledged', async () => {
    const t = make();
    // The page before the reload: it read up to seq 3, acknowledged up to 2.
    const before = await t.hoomi.location.startTracking();
    await t.hoomi.location.readTrack({ trackingId: before.trackingId, afterSeq: 2 });
    t.host.pushTrackFix();

    // The reloaded page knows nothing but that it wants to track.
    const seqs: number[] = [];
    const handle = await t.hoomi.location.track(undefined, (fix) => seqs.push(fix.seq));
    expect(handle.trackingId).toBe(before.trackingId);
    expect(handle.resumed).toBe(true);
    await vi.waitFor(() => expect(seqs).toEqual([3, 4]));
  });

  it('delivers nothing after stop(), even from a read already in flight', async () => {
    const t = make();
    const { handle, seqs } = await startTracked(t);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.host.delay(30);
      t.host.pushTrackFix(); // a slow read is now in flight
      await tick(5);
      await handle.stop();
      await tick(80);
      expect(seqs).toEqual([1, 2, 3]);
      expect(unhandled).not.toHaveBeenCalled();
      expect(countOf(t, 'location.stopTracking')).toBe(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('stop() is idempotent', async () => {
    const t = make();
    const { handle } = await startTracked(t);
    await handle.stop();
    await handle.stop();
    expect(countOf(t, 'location.stopTracking')).toBe(1);
  });

  it("rejects with the host's error when the host cannot track", async () => {
    const t = make();
    t.host.fail('location.startTracking', 'E_NOT_IMPLEMENTED');
    const err = await t.hoomi.location.track(undefined, () => {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_NOT_IMPLEMENTED');

    // Nothing was left listening.
    t.host.emit('lifecycle.show', {});
    await tick(10);
    expect(countOf(t, 'location.readTrack')).toBe(0);
  });

  it('drains what is left, then reports a dead location source as retryable', async () => {
    const t = make();
    const { seqs, errors, completed } = await startTracked(t);
    const wake = t.host.fail('location.readTrack', 'E_INTERNAL');
    t.host.pushTrackFix();
    await tick(10);
    wake();
    t.host.failTracking();

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(errors[0]!.code).toBe('E_UNAVAILABLE');
    expect(errors[0]!.retryable).toBe(true);
    expect(completed()).toBe(0);
    expect(countOf(t, 'location.stopTracking')).toBe(1);
  });

  it('drains what is left, then completes when the session expires', async () => {
    const t = make();
    const { seqs, errors, completed } = await startTracked(t);
    const wake = t.host.fail('location.readTrack', 'E_INTERNAL');
    t.host.pushTrackFix();
    await tick(10);
    wake();
    t.host.expireTracking();

    await vi.waitFor(() => expect(completed()).toBe(1));
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(errors).toEqual([]);
    expect(countOf(t, 'location.stopTracking')).toBe(1);
  });

  it('reports fixes the host had to drop', async () => {
    const t = make({ limits: { maxTrackedFixes: 2 } });
    const dropped: number[] = [];
    const seqs: number[] = [];
    await t.hoomi.location.track(undefined, (fix) => seqs.push(fix.seq), { onDropped: (n) => dropped.push(n) });
    await vi.waitFor(() => expect(seqs).toEqual([2, 3]));
    expect(dropped).toEqual([1]);
  });

  it('drains a session that already ended before starting a fresh one', async () => {
    const t = make();
    const old = await t.hoomi.location.startTracking();
    t.host.expireTracking();

    const seqs: number[] = [];
    const handle = await t.hoomi.location.track(undefined, (fix) => seqs.push(fix.seq));
    expect(handle.trackingId).not.toBe(old.trackingId);
    // The old session's three fixes, then the new session's three.
    await vi.waitFor(() => expect(seqs).toEqual([1, 2, 3, 1, 2, 3]));
  });

  it('aborting the signal stops tracking', async () => {
    const t = make();
    const controller = new AbortController();
    const { seqs } = await startTracked(t, { signal: controller.signal });
    controller.abort();
    await vi.waitFor(() => expect(countOf(t, 'location.stopTracking')).toBe(1));
    expect(() => t.host.pushTrackFix()).toThrow(/not tracking/i);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('reports the session vanishing underneath it', async () => {
    const t = make();
    const { handle, errors } = await startTracked(t);
    await t.hoomi.location.stopTracking(handle.trackingId); // someone else stopped it
    t.host.emit('lifecycle.show', {});
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.code).toBe('E_INVALID_PARAMS');
  });
});
