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

/**
 * The host's maximum. A drain after a long background stretch is many reads
 * back to back, and the host rate-limits them, so each one carries as much as
 * it is allowed to.
 */
const PAGE_SIZE = 500;
/** Wait before re-reading after a transient failure, unless the host says how long. */
const RETRY_MS = 1_000;

export function createLocationTracker(client: BridgeClient, raw: TrackingRawApi) {
  // One tracker per page. The host keeps a single log per micro-app, so two
  // trackers would each acknowledge fixes the other had not seen yet, and the
  // first to stop would end the session under the second.
  let busy = false;

  return async function track(
    params: StartTrackingParams | undefined,
    observer: SubscriptionObserver<TrackedFix> | ((fix: TrackedFix) => void),
    opts: TrackOptions = {},
  ): Promise<TrackingHandle> {
    if (busy) {
      throw new HoomiError('E_INVALID_PARAMS', 'location.track: already tracking — stop() the existing handle first');
    }
    busy = true;
    try {
      return await attach(params, observer, opts, () => {
        busy = false;
      });
    } catch (err) {
      busy = false;
      throw err;
    }
  };

  async function attach(
    params: StartTrackingParams | undefined,
    observer: SubscriptionObserver<TrackedFix> | ((fix: TrackedFix) => void),
    opts: TrackOptions,
    onReleased: () => void,
  ): Promise<TrackingHandle> {
    const o: SubscriptionObserver<TrackedFix> = typeof observer === 'function' ? { next: observer } : observer;
    const { onDropped, signal, timeoutMs } = opts;
    const callOpts: CallOptions = timeoutMs === undefined ? {} : { timeoutMs };
    // The host holds startTracking open while the user reads the consent
    // sheet. The SDK's default timeout would give up first and leave GPS
    // running on the host with no handle here to stop it, so the start only
    // times out if the caller asked for that.
    const startOpts: CallOptions = { timeoutMs: timeoutMs ?? 0, ...(signal ? { signal } : {}) };

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
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hostStopped = false;
    const detach: Array<() => void> = [];
    const release = () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      for (const off of detach.splice(0)) off();
      onReleased();
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
        hostStopped = await raw.stopTracking(trackingId, callOpts).then(
          () => true,
          () => false,
        );
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
          try {
            o.error?.(err);
          } catch {
            /* the page's callback threw; there is no one left to tell */
          }
          return;
        }
        // Anything else is transient — a rate limit partway through a long
        // backlog, a timeout. The cursor has not moved, so reading again loses
        // nothing; and it has to happen on a timer, because a session that has
        // already ended will never send another hint.
        if (retry === undefined) {
          const wait = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
          retry = setTimeout(() => {
            retry = undefined;
            void drain();
          }, typeof wait === 'number' ? wait : RETRY_MS);
        }
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
      if (!stopped) release();
      // Kept separate from `stopped`: if this call does not reach the host,
      // GPS is still on, and the next stop() has to try again rather than
      // conclude there is nothing left to do.
      if (hostStopped) return;
      try {
        await raw.stopTracking(trackingId, callOpts);
      } catch (err) {
        if (!(err instanceof HoomiError && err.code === 'E_INVALID_PARAMS')) throw err;
        // The host no longer has the session: it is as stopped as it can be.
      }
      hostStopped = true;
    };

    if (signal) {
      const onAbort = () => void stop().catch(() => undefined);
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        detach.push(() => signal.removeEventListener('abort', onAbort));
      }
    }

    void drain();
    return { trackingId, resumed, stop };
  }
}
