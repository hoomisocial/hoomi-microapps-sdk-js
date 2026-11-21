/**
 * `location.track()`: every fix of a tracking session, in order.
 *
 * The host does not push fixes. A page's JavaScript is suspended while the
 * host app is backgrounded, so a pushed fix can vanish without either side
 * knowing; instead the host keeps a numbered log and the page reads *after* a
 * sequence number, which also acknowledges everything up to it. This module
 * hides that cursor.
 *
 * It reads whenever something suggests there is more — the host's
 * `location.trackAvailable` hint, the page becoming visible again, and once at
 * the start — and never relies on any one of those arriving. A hint lost
 * while the page slept costs nothing: the next read picks up from the cursor.
 */

import type { BridgeClient, CallOptions, SubscriptionObserver } from '../core/client.js';
import { HoomiError } from '../core/errors.js';
import type { ReadTrackParams, ReadTrackResult, StartTrackingParams, TrackedFix, TrackingSession } from './types.js';

export interface TrackOptions extends CallOptions {
  /**
   * Called with how many fixes the host evicted unread since the last report.
   * It only happens when the page stayed asleep long enough to fill the
   * host's buffer; the gap is real and cannot be recovered.
   */
  onDropped?: (count: number) => void;
}

export interface TrackingHandle {
  readonly trackingId: string;
  /**
   * True when this attached to a session that was already running — a page
   * reload, typically. Fixes the previous page read but had not yet
   * acknowledged are delivered again, so delivery is at-least-once across a
   * reload; `seq` identifies a repeat.
   */
  readonly resumed: boolean;
  /** Stops GPS on the host and discards anything unread. Safe to call twice. */
  stop(): Promise<void>;
}

export interface TrackingRawApi {
  startTracking(params?: StartTrackingParams, opts?: CallOptions): Promise<TrackingSession>;
  readTrack(params: ReadTrackParams, opts?: CallOptions): Promise<ReadTrackResult>;
  stopTracking(trackingId: string, opts?: CallOptions): Promise<void>;
}

const PAGE_SIZE = 200;

export function createLocationTracker(client: BridgeClient, raw: TrackingRawApi) {
  return async function track(
    params: StartTrackingParams | undefined,
    observer: SubscriptionObserver<TrackedFix> | ((fix: TrackedFix) => void),
    opts: TrackOptions = {},
  ): Promise<TrackingHandle> {
    const o: SubscriptionObserver<TrackedFix> = typeof observer === 'function' ? { next: observer } : observer;
    const { onDropped, signal, timeoutMs } = opts;
    const callOpts: CallOptions = timeoutMs === undefined ? {} : { timeoutMs };
    const startOpts: CallOptions = signal ? { ...callOpts, signal } : callOpts;

    let lastDelivered = 0;
    let droppedSeen = 0;

    /** Reads one session to its end, delivering as it goes. Returns its state. */
    const readAll = async (trackingId: string, isStopped: () => boolean): Promise<string> => {
      for (;;) {
        const page = await raw.readTrack({ trackingId, afterSeq: lastDelivered, limit: PAGE_SIZE }, callOpts);
        if (isStopped()) return page.state;
        for (const fix of page.fixes) {
          if (fix.seq <= lastDelivered) continue;
          lastDelivered = fix.seq;
          try {
            o.next?.(fix);
          } catch {
            // A bug in the page's callback must not cost it the rest of the trip.
          }
        }
        if (page.droppedCount > droppedSeen) {
          const count = page.droppedCount - droppedSeen;
          droppedSeen = page.droppedCount;
          try {
            onDropped?.(count);
          } catch {
            /* as above */
          }
        }
        if (!page.hasMore) return page.state;
      }
    };

    let session = await raw.startTracking(params, startOpts);
    if (session.state !== 'active') {
      // A previous session ended on its own and was never stopped. The host
      // will not replace it — that would wipe what is unread — so read it out,
      // stop it, and only then start the one that was asked for.
      await readAll(session.trackingId, () => false);
      await raw.stopTracking(session.trackingId, callOpts);
      lastDelivered = 0;
      droppedSeen = 0;
      session = await raw.startTracking(params, startOpts);
    }
    const { trackingId, resumed } = session;

    let stopped = false;
    let draining = false;
    let drainAgain = false;
    const detach: Array<() => void> = [];
    const release = () => {
      stopped = true;
      for (const off of detach.splice(0)) off();
    };

    const drain = async (): Promise<void> => {
      if (stopped) return;
      if (draining) {
        // Something new arrived mid-read. One more pass afterwards covers it,
        // however many triggers piled up.
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        let state: string;
        do {
          drainAgain = false;
          state = await readAll(trackingId, () => stopped);
        } while (drainAgain && !stopped);
        if (stopped || state === 'active') return;

        // Recording ended on the host and everything recorded has been
        // delivered. Free the host's log, then tell the page why.
        release();
        await raw.stopTracking(trackingId, callOpts).catch(() => undefined);
        if (state === 'expired') {
          o.complete?.();
        } else {
          o.error?.(
            new HoomiError('E_UNAVAILABLE', 'Location tracking stopped: the location source became unavailable', {
              retryable: true,
              data: { state },
            }),
          );
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof HoomiError && err.code === 'E_INVALID_PARAMS') {
          // The session no longer exists on the host. Nothing more can come.
          release();
          o.error?.(err);
        }
        // Anything else is transient: the cursor has not moved, so the next
        // trigger reads the same fixes again.
      } finally {
        draining = false;
      }
    };

    detach.push(
      client.on('location.trackAvailable', (data) => {
        if ((data as { trackingId?: unknown } | null | undefined)?.trackingId === trackingId) void drain();
      }),
      client.on('lifecycle.show', () => void drain()),
    );

    const stop = async (): Promise<void> => {
      if (stopped) return;
      release();
      await raw.stopTracking(trackingId, callOpts);
    };

    if (signal) {
      const onAbort = () => void stop().catch(() => undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      detach.push(() => signal.removeEventListener('abort', onAbort));
    }

    void drain();
    return { trackingId, resumed, stop };
  };
}
