'use strict';

// kfadapter.js — the ONLY module that speaks KaraFun's wire protocol.
//
// Everything KaraFun-specific is quarantined here so the rest of the system
// (fairshare, store, server) stays protocol-agnostic. The exact frame shapes on
// ws://localhost:57570 are UNCONFIRMED, so the parsers below are best-effort
// GUESSES: they try the field names a KaraFun-style control socket is likely to
// use and return null when they don't recognize a frame. That makes the first
// observe run pure observation — it logs every raw frame, and when a guess
// happens to match we learn the shape faster. This is the file that gets
// rewritten once the probe confirms the real frames; then OBSERVE=0.
//
// The three gating unknowns each parser is here to answer:
//   1. Does each queue entry carry a singerName / id?        -> parseQueue
//   2. What frame signals a song finished, and who sang it?  -> detectFinished
//   3. Can the catalog be searched over the same socket?     -> parseCatalog / buildSearch

// ---- field-shape guesses (replace once the probe confirms real frames) -----
const QUEUE_KEYS = ['list', 'queue', 'songs', 'entries'];
const CATALOG_KEYS = ['catalog', 'results', 'catalogList', 'songs'];
const FINISHED_STATES = ['ended', 'stopped', 'finished', 'complete'];

function firstArray(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  return null;
}

/**
 * Normalize a raw inbound frame (string or Buffer) into a typed event the
 * server can switch on / log. Best-effort type tagging from the guesses above.
 *
 * STUB — confirm via probe.
 *
 * @param {string|Buffer} raw
 * @returns {{type:string, raw:string, json:(object|null)}}
 */
function parseInbound(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* not JSON (some versions emit XML) — the raw text is what matters */
  }

  let type = 'unknown';
  if (json) {
    if (detectFinished(json)) type = 'finished';
    else if (firstArray(json, QUEUE_KEYS)) type = 'queue';
    else if (firstArray(json, CATALOG_KEYS)) type = 'catalog';
  }
  return { type, raw: text, json };
}

/**
 * Extract the player's current queue as entries we can map to singers.
 *
 * GATING UNKNOWN #1: does each entry carry a singerName / id? If it does we can
 * attribute plays directly; if not, the server falls back to its own add-time
 * queue->fingerprint mapping.
 *
 * STUB — best-effort guess; confirm via probe.
 *
 * @param {object} frame  parsed json from parseInbound
 * @returns {Array<{id:*, songId:*, title:?string, artist:?string, singerName:?string}>}
 */
function parseQueue(frame) {
  const list = firstArray(frame, QUEUE_KEYS);
  if (!list) return [];
  return list.map((it, i) => ({
    id: it.id ?? it.entryId ?? `idx${i}`,
    songId: it.songId ?? it.song_id ?? it.id ?? null,
    title: it.title ?? it.name ?? null,
    artist: it.artist ?? null,
    // The crucial field. Consistently present => name-based attribution works.
    singerName: it.singer ?? it.singerName ?? it.user ?? null,
  }));
}

/**
 * Detect a "song finished" frame and, if possible, say which entry/singer.
 *
 * GATING UNKNOWN #2: what frame signals completion, and does it name who/what?
 * If `singer` comes back null, the server attributes the play via its own queue
 * mapping instead (README fallback).
 *
 * STUB — best-effort guess; confirm via probe.
 *
 * @param {object} frame
 * @returns {{finishedId:*, singer:(string|null)}|null}
 */
function detectFinished(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const signal = frame.event ?? frame.state ?? frame.status;
  if (typeof signal === 'string' && FINISHED_STATES.includes(signal.toLowerCase())) {
    return {
      finishedId: frame.id ?? frame.entryId ?? frame.songId ?? null,
      singer: frame.singer ?? frame.singerName ?? frame.user ?? null,
    };
  }
  return null;
}

/**
 * Extract catalog search results from a frame.
 *
 * GATING UNKNOWN #3: can the catalog be searched over the local socket? If yes,
 * results arrive in one of these shapes; if not, search routes elsewhere.
 *
 * STUB — best-effort guess; confirm via probe.
 */
function parseCatalog(frame) {
  const results = firstArray(frame, CATALOG_KEYS);
  if (!results) return null;
  return results.map((it) => ({
    songId: it.songId ?? it.id ?? null,
    title: it.title ?? it.name ?? null,
    artist: it.artist ?? null,
  }));
}

/**
 * Build a catalog-search request frame to send over the same socket.
 * STUB — real shape unknown; placeholder so callers have something to log/send.
 *
 * @param {string} query
 * @returns {string}
 */
function buildSearch(query) {
  return JSON.stringify({ action: 'search', query });
}

/**
 * Classify a proxied KaraFun *web UI* request (proxy mode) by method + URL, so
 * observe mode can log "this looked like an add/search" and attribute it to the
 * guest's fingerprint. Best-effort URL heuristics — the real KaraFun web
 * endpoints are unconfirmed; the probe / a first proxied session reveal them,
 * and then this (and body parsing for the title/songId) gets made precise.
 *
 * STUB — confirm against real KaraFun web requests.
 *
 * @param {string} method
 * @param {string} url
 * @returns {{kind:'add'|'search'|'queueop'|'other', title?:string}}
 */
function sniffWeb(method, url) {
  const u = (url || '').toLowerCase();
  if (/(^|\/)(add|enqueue)(\/|\?|$)|queue\/add|playlist\/add/.test(u)) return { kind: 'add' };
  if (/(^|\/)(search|catalog|songs)(\/|\?|$)|[?&]q=/.test(u)) return { kind: 'search' };
  if (/(^|\/)(remove|delete|move|reorder|up|down)(\/|\?|$)/.test(u)) return { kind: 'queueop' };
  return { kind: 'other' };
}

// Pull a song title / id out of one object, shallow-recursing into the usual
// containers. Mutates `out`; first non-null wins.
function pickSong(out, obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  const title = obj.title ?? obj.songTitle ?? obj.name ?? obj.track ?? obj.song;
  const songId = obj.songId ?? obj.song_id ?? obj.id;
  if (typeof title === 'string' && out.title == null) out.title = title.slice(0, 120);
  if ((typeof songId === 'string' || typeof songId === 'number') && out.songId == null) {
    out.songId = String(songId).slice(0, 40);
  }
  for (const key of ['song', 'track', 'item', 'data', 'payload']) {
    if (obj[key] && typeof obj[key] === 'object') pickSong(out, obj[key], depth + 1);
  }
}

/**
 * Best-effort extraction of the song from a proxied "add" request — so observe
 * mode can log *what* each guest requested at request time (in addition to the
 * queue-echo correlation). Reads the URL query and, for bodied requests, a JSON
 * or urlencoded body.
 *
 * STUB — the real KaraFun add shape is confirmed by the probe; this just tries
 * the common field names so the first proxied session is still informative.
 *
 * @param {string} method
 * @param {string} url
 * @param {string} contentType
 * @param {Buffer|string|null} body
 * @returns {{title:(string|null), songId:(string|null)}}
 */
function parseAddRequest(method, url, contentType, body) {
  const out = { title: null, songId: null };

  try {
    const u = new URL(url, 'http://x');
    pickSong(out, Object.fromEntries(u.searchParams.entries()));
  } catch (_) { /* malformed url */ }

  if (body && body.length) {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('json') || /^\s*[{[]/.test(text)) {
      try { pickSong(out, JSON.parse(text)); } catch (_) { /* not json */ }
    } else if (ct.includes('urlencoded') || (text.includes('=') && !text.includes(' '))) {
      try { pickSong(out, Object.fromEntries(new URLSearchParams(text).entries())); } catch (_) {}
    }
  }
  return out;
}

/**
 * Move the entry `id` to `targetIndex` in the player's queue.
 *
 * Two strategies are sketched; which is real depends on what the protocol
 * supports (README "Reorder strategy ... unknown until the probe"):
 *   (A) native move     — one frame: {action:'move', id, to:targetIndex}
 *   (B) remove + re-add — pull the entry and re-insert at the target slot
 *
 * In OBSERVE mode this SENDS NOTHING; it returns the action it *would* take so
 * the server can log "WOULD ...". When observe is false (and the stubs above are
 * filled in), it calls `playerSend(frame)`.
 *
 * @param {(frame:string)=>void} playerSend
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
    return { strategy: 'native(observe)', frames, sent: false };
  }

  for (const f of frames) playerSend(f);
  return { strategy: 'native', frames, sent: true };
}

module.exports = {
  parseInbound,
  parseQueue,
  detectFinished,
  parseCatalog,
  buildSearch,
  sniffWeb,
  parseAddRequest,
  moveTo,
};
