'use strict';

// fairshare.js — pure ordering. No KaraFun protocol coupling, no I/O.
//
// Whoever has sung least goes next. Nobody is blocked; the order just keeps
// rebalancing. A singer who stacks several songs penalizes their own later
// entries so they don't hog the front of the line.
//
// score(entry) = playedOf(fp) + weight * (songs of this fp already placed ahead)
// Lower score goes first. Ties break by `seq` (FIFO — earlier add wins).
//
// The README states this as `score = played + weight*pendingAhead`. We resolve
// `pendingAhead` greedily as we build the output, so the Nth song a single
// singer adds is scored as if N-1 of theirs are already ahead of it. That makes
// stacking self-throttling without ever blocking anyone. (Because each song's
// score is fixed by how many of that singer's songs precede it in seq order,
// this greedy selection is equivalent to a stable sort by (score, seq).)

/**
 * Core ranking. Returns a NEW array of *annotated copies* in fair-share order,
 * each carrying `_played`, `_pendingAhead`, `_score`, `_position` for
 * transparency (used by observe-mode logging and the guest standings). Pure.
 *
 * @param {Array<{id:*, fp:string, seq:number, title?:string, singerName?:string}>} pending
 * @param {(fp:string)=>number} playedOf
 * @param {number} weight
 * @returns {Array}
 */
function _rank(pending, playedOf, weight) {
  if (!Array.isArray(pending) || pending.length === 0) return [];
  const w = Number.isFinite(weight) ? weight : 1.0;

  const remaining = pending.slice();
  const placedAhead = new Map(); // fp -> count of this fp's songs already in result
  const result = [];

  while (remaining.length > 0) {
    let bestIdx = 0;
    let best = remaining[0];
    let bestAhead = placedAhead.get(best.fp) || 0;
    let bestScore = playedOf(best.fp) + w * bestAhead;

    for (let i = 1; i < remaining.length; i++) {
      const e = remaining[i];
      const ahead = placedAhead.get(e.fp) || 0;
      const s = playedOf(e.fp) + w * ahead;
      if (s < bestScore || (s === bestScore && e.seq < best.seq)) {
        best = e;
        bestIdx = i;
        bestAhead = ahead;
        bestScore = s;
      }
    }

    result.push({
      ...best,
      _played: playedOf(best.fp),
      _pendingAhead: bestAhead,
      _score: bestScore,
      _position: result.length,
    });
    placedAhead.set(best.fp, bestAhead + 1);
    remaining.splice(bestIdx, 1);
  }

  return result;
}

/**
 * Reorder a pending queue fair-share. Pure: does not mutate `pending`.
 * Returns clean entry copies (no `_` annotation fields).
 *
 * @param {Array} pending
 * @param {(fp:string)=>number} playedOf  lifetime play count for a fingerprint
 * @param {number} weight                 penalty per same-singer song already ahead
 * @returns {Array} a new array, fair-share ordered
 */
function order(pending, playedOf, weight) {
  return _rank(pending, playedOf, weight).map((e) => {
    const { _played, _pendingAhead, _score, _position, ...rest } = e;
    return rest;
  });
}

/**
 * Like `order`, but keeps the `_played` / `_pendingAhead` / `_score` /
 * `_position` annotations so observe mode can log *why* the order is what it is.
 */
function annotate(pending, playedOf, weight) {
  return _rank(pending, playedOf, weight);
}

/**
 * Convenience: 1-based position of a given entry id in the fair-share order,
 * plus how many songs are ahead of it. Returns null if the id isn't pending.
 */
function standingFor(pending, playedOf, weight, id) {
  const ordered = _rank(pending, playedOf, weight);
  const idx = ordered.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  return { position: idx + 1, ahead: idx, total: ordered.length };
}

module.exports = { order, annotate, standingFor };
