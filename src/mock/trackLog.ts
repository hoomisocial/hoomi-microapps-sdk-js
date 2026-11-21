import type { GeoPosition, TrackedFix } from '../api/types.js';

export interface TrackLogPage {
  fixes: TrackedFix[];
  lastSeq: number;
  hasMore: boolean;
  droppedCount: number;
}

/**
 * The unread fixes of one tracking session — the mock's copy of the host's
 * `TrackLog`, with the same three rules: `seq` counts up from 1, reading after
 * a cursor discards everything at or before it, and a full buffer evicts its
 * oldest fix and counts the eviction rather than hiding it.
 */
export class TrackLog {
  readonly #max: number;
  #fixes: TrackedFix[] = [];
  #lastSeq = 0;
  #droppedCount = 0;

  constructor(maxBufferedFixes: number) {
    this.#max = maxBufferedFixes;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  record(fix: GeoPosition): number {
    if (this.#fixes.length >= this.#max) {
      this.#fixes.shift();
      this.#droppedCount += 1;
    }
    this.#lastSeq += 1;
    this.#fixes.push({ ...fix, seq: this.#lastSeq });
    return this.#lastSeq;
  }

  read(afterSeq: number, limit: number): TrackLogPage {
    let acknowledged = 0;
    while (acknowledged < this.#fixes.length && this.#fixes[acknowledged]!.seq <= afterSeq) acknowledged += 1;
    if (acknowledged > 0) this.#fixes.splice(0, acknowledged);
    return {
      fixes: this.#fixes.slice(0, limit),
      lastSeq: this.#lastSeq,
      hasMore: this.#fixes.length > limit,
      droppedCount: this.#droppedCount,
    };
  }
}
