'use strict';

// kfadapter.js — the ONLY module that speaks KaraFun's wire protocol.
//
// Everything KaraFun-specific is quarantined here so the rest of the system
// (fairshare, store, server) stays protocol-agnostic. Right now every export is
// a STUB: the exact frame shapes on ws://localhost:57570 are unconfirmed. This
// is the file that gets rewritten after the first observe run / probe reveals
// the real frames. See README "The one gating unknown".
//
// The three unknowns each export is here to answer:
//   1. Does each queue entry carry a singerName / id?        -> parseQueue
//   2. What frame signals a song finished, and who sang it?  -> detectFinished
//   3. Can the catalog be searched over the same socket?     -> buildSearch
//
// Until those are confirmed, callers run in OBSERVE mode: nothing here sends
// mutating frames to the player.

/**
 * Normalize a raw inbound frame (string or Buffer) from the player socket into
 * a typed event the server can switch on. In observe mode we mostly tag frames
 * `unknown` and rely on the logs to reveal structure.
 *
 * STUB — confirm via probe. Replace the `type` detection with the real frames.
 *
 * @param {string|Buffer} raw
 * @returns {{type:string, raw:*, json:(object|null)}}
 */
function parseInbound(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* not JSON, or not JSON we understand yet */
  }

  // STUB: real type discrimination goes here once frames are known, e.g.
  //   if (json && json.event === 'queue')    return { type: 'queue', ... }
  //   if (json && json.event === 'finished') return { type: 'finished', ... }
  return { type: 'unknown', raw: text, json };
}

/**
 * Extract the player's current queue as a list of entries we can map to singers.
 *
 * GATING UNKNOWN #1: does each entry carry a singerName / id? If it does, we can
 * attribute plays directly. If not, the server falls back to its own add-time
 * queue->fingerprint mapping.
 *
 * STUB — confirm via probe.
 *
 * @param {object} frame  a parsed inbound frame (json from parseInbound)
 * @returns {Array<{id:*, title?:string, singerName?:string}>}
 */
function parseQueue(frame) {
  // STUB: e.g. return frame.queue.map(q => ({ id: q.id, title: q.title,
  //                                            singerName: q.singer }));
  return [];
}

/**
 * Detect a "song finished" frame and, if possible, say which entry/singer.
 *
 * GATING UNKNOWN #2: what frame signals completion, and does it name who/what?
 * If `singer` comes back null, the server attributes the play via its own queue
 * mapping instead (README fallback).
 *
 * STUB — confirm via probe.
 *
 * @param {object} frame
 * @returns {{finishedId:*, singer:(string|null)}|null}
 */
function detectFinished(frame) {
  // STUB: e.g. if (frame.event === 'songEnded')
  //   return { finishedId: frame.id, singer: frame.singer ?? null };
  return null;
}

/**
 * Build a catalog-search request frame to send over the same socket.
 *
 * GATING UNKNOWN #3: can the catalog be searched over the local control socket?
 * If not, search has to go a different route (decided after the probe).
 *
 * STUB — confirm via probe.
 *
 * @param {string} query
 * @returns {string} a frame ready for ws.send (JSON string placeholder)
 */
function buildSearch(query) {
  // STUB: real shape unknown. Placeholder so callers have something to log.
  return JSON.stringify({ action: 'search', query });
}

/**
 * Move the entry `id` to `targetIndex` in the player's queue.
 *
 * Two strategies are sketched; which one is real depends on what the protocol
 * supports (README "Reorder strategy ... unknown until the probe"):
 *   (A) native move  — one frame: {action:'move', id, to:targetIndex}
 *   (B) remove + re-add — pull the entry and re-insert at the target slot
 *
 * In OBSERVE mode this SENDS NOTHING. It returns the action it *would* take so
 * the server can log "WOULD ...". When observe is false (and the stubs above are
 * filled in), it would call `playerSend(frame)`.
 *
 * @param {(frame:string)=>void} playerSend  sender into the player socket
 * @param {*} id
 * @param {number} targetIndex
 * @param {boolean} observe
 * @returns {{strategy:string, frames:string[], sent:boolean}}
 */
function moveTo(playerSend, id, targetIndex, observe = true) {
  // ---- strategy (A): native move ------------------------------------------
  const nativeFrame = JSON.stringify({ action: 'move', id, to: targetIndex });

  // ---- strategy (B): remove + re-add (fallback if no native move) ---------
  // const removeFrame = JSON.stringify({ action: 'remove', id });
  // const addFrame    = JSON.stringify({ action: 'add', id, at: targetIndex });

  const frames = [nativeFrame]; // swap in [removeFrame, addFrame] if (A) unsupported

  if (observe) {
    // OBSERVE MODE: compute intent, send nothing.
    return { strategy: 'native(observe)', frames, sent: false };
  }

  // LIVE: only reached once the stubs are confirmed and OBSERVE=0.
  for (const f of frames) playerSend(f);
  return { strategy: 'native', frames, sent: true };
}

module.exports = {
  parseInbound,
  parseQueue,
  detectFinished,
  buildSearch,
  moveTo,
};
