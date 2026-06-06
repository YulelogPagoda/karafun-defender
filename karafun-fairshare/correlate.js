'use strict';

// correlate.js — pure, timing-based mapping of "a guest added a song" to "this
// row appeared in the player's queue". No protocol coupling, no I/O.
//
// Why this exists: in proxy mode we learn *who* added (the fingerprint, from the
// proxied request) at time T. Separately, the player's control API reports its
// queue, where a new entry appears ~T. If the queue entry carries no identifier
// we control, we can't bind the two directly — so we correlate by arrival time:
// the new queue entry is attributed to the closest recent unmatched add within
// a window. Good enough for a party; deterministic and unit-testable.
//
// Timestamps are passed in explicitly (not read from the clock) so behavior is
// fully testable. Wire Date.now() at the call sites.

class Correlator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs=8000]    max |add - entry| gap to match
   * @param {number} [opts.retentionMs=60000] how long to keep adds for matching
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? 8000;
    this.retentionMs = opts.retentionMs ?? 60000;
    this.recentAdds = []; // { fp, ts, title, matched }
    this.entryToFp = new Map(); // queueEntryId -> fp
  }

  /** Record that `fp` added a song at `ts` (ms). */
  recordAdd(fp, ts, title = null) {
    this.recentAdds.push({ fp, ts, title, matched: false });
    this._prune(ts);
    return this;
  }

  /**
   * Bind a queue entry (first seen at `ts`) to the best unmatched recent add.
   * Idempotent: a given entryId keeps its first binding. Returns the fp it was
   * bound to, or null if nothing matched within the window.
   */
  attachEntry(entryId, ts) {
    if (this.entryToFp.has(entryId)) return this.entryToFp.get(entryId);

    let best = null;
    let bestDelta = Infinity;
    for (const a of this.recentAdds) {
      if (a.matched) continue;
      const delta = Math.abs(ts - a.ts);
      if (delta <= this.windowMs && delta < bestDelta) {
        best = a;
        bestDelta = delta;
      }
    }
    if (!best) return null;
    best.matched = true;
    this.entryToFp.set(entryId, best.fp);
    return best.fp;
  }

  /** Fingerprint previously bound to a queue entry, or null. */
  fpForEntry(entryId) {
    return this.entryToFp.get(entryId) ?? null;
  }

  /** Forget a finished/removed entry's binding. */
  forget(entryId) {
    this.entryToFp.delete(entryId);
  }

  /** Count of recorded adds still awaiting a queue match (diagnostics). */
  pendingAdds() {
    return this.recentAdds.filter((a) => !a.matched).length;
  }

  _prune(now) {
    this.recentAdds = this.recentAdds.filter((a) => now - a.ts <= this.retentionMs);
  }
}

module.exports = { Correlator };
