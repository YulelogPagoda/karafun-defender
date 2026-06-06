'use strict';

// store.js — identity + play counts. In-memory Map with a JSON snapshot so the
// standings survive a restart mid-party.
//
// Identity is resolved across THREE signals, not one key:
//   - token : server-minted httpOnly cookie (strong; survives a localStorage clear)
//   - ip    : device LAN IP
//   - bfp   : passive browser fingerprint (page mode only)
// An identity accumulates every value it has been seen with. On each visit we
// score existing identities by how many signals match (token weighted strongest)
// and reuse the best match when the token matches OR at least two signals agree.
// The effect: a guest can change ANY ONE signal — clear cookies, hop networks,
// or present a new fingerprint — and still resolve to the same person (and the
// same play count). Changing two at once is treated as a new identity.
//
// Honest limits: proxy mode has only token+ip (no bfp), so a cookie clear there
// can't be recovered from IP alone (IP is too weak to merge on its own). And
// two strangers would only false-merge on a double coincidence (e.g. same IP
// AND same fingerprint), which is rare at party scale.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(__dirname, 'store.snapshot.json');

const addUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

class Store {
  /** @param {string} [file] snapshot path; defaults to STORE_FILE or store.snapshot.json */
  constructor(file) {
    this.file = file || process.env.STORE_FILE || DEFAULT_FILE;
    /** @type {Map<string,{id,name,played,firstSeen,tokens:string[],ips:string[],bfps:string[]}>} */
    this.people = new Map();
    this._dirty = false;
  }

  /**
   * Resolve (or create) an identity from any combination of signals, merging the
   * new signal values in. Returns the identity record. `fp` for the rest of the
   * system is `rec.id`.
   *
   * @param {{token?:string, ip?:string, bfp?:string, name?:string}} sig
   */
  identify(sig = {}) {
    const { token, ip, bfp, name } = sig;

    // Score existing identities. Token is strong (unique, random); ip and bfp
    // are weaker corroborating signals.
    let best = null;
    let bestScore = 0;
    for (const rec of this.people.values()) {
      let s = 0;
      if (token && rec.tokens.includes(token)) s += 2;
      if (ip && rec.ips.includes(ip)) s += 1;
      if (bfp && rec.bfps.includes(bfp)) s += 1;
      if (s > bestScore) { bestScore = s; best = rec; }
    }

    // Reuse when token matches (score >= 2) OR two weak signals agree (1+1).
    let rec = bestScore >= 2 ? best : null;
    if (!rec) {
      rec = {
        id: token || bfp || ip || crypto.randomBytes(8).toString('hex'),
        name: name || 'guest',
        played: 0,
        firstSeen: Date.now(),
        tokens: [],
        ips: [],
        bfps: [],
      };
      this.people.set(rec.id, rec);
    }
    if (name && name !== rec.name) rec.name = name;
    addUnique(rec.tokens, token);
    addUnique(rec.ips, ip);
    addUnique(rec.bfps, bfp);
    this._dirty = true;
    return rec;
  }

  /** Increment lifetime play count for an identity id. */
  recordPlay(id) {
    let rec = this.people.get(id);
    if (!rec) {
      rec = { id, name: 'guest', played: 0, firstSeen: Date.now(), tokens: [], ips: [], bfps: [] };
      this.people.set(id, rec);
    }
    rec.played += 1;
    this._dirty = true;
    return rec.played;
  }

  /** Lifetime play count for an identity id (0 if unknown). */
  played(id) {
    const rec = this.people.get(id);
    return rec ? rec.played : 0;
  }

  /**
   * Zero everyone's play count, keeping identities. Used by the operator "reset
   * stats" control: early in the night, before there are enough people to need
   * fairness, reset so order falls back to first-come (equal scores -> FIFO) and
   * early arrivers can keep singing.
   *
   * @returns {number} how many identities were reset
   */
  resetStats() {
    let n = 0;
    for (const rec of this.people.values()) {
      if (rec.played !== 0) { rec.played = 0; n += 1; }
    }
    this._dirty = true;
    return n;
  }

  get(id) {
    return this.people.get(id);
  }

  /** Snapshot of all records as a plain object keyed by identity id. */
  all() {
    const out = {};
    for (const [id, rec] of this.people) out[id] = { ...rec };
    return out;
  }

  /** Load the snapshot from disk if present. Safe to call when the file is absent. */
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.people = new Map();
      for (const [id, rec] of Object.entries(data)) {
        // Normalize/migrate older snapshots to the multi-signal shape.
        rec.id = id;
        rec.tokens = rec.tokens || [];
        rec.ips = rec.ips || (rec.lastIp ? [rec.lastIp] : []);
        rec.bfps = rec.bfps || (rec.bfp ? [rec.bfp] : []);
        if (!rec.tokens.length && !/^[0-9a-f]{16}$/.test(id)) addUnique(rec.tokens, id);
        delete rec.lastIp; delete rec.bfp; delete rec.clientFp;
        this.people.set(id, rec);
      }
      this._dirty = false;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] could not load ${this.file}: ${err.message}`);
      }
    }
    return this;
  }

  /** Atomically write the snapshot. No-op when nothing changed since last write. */
  persist(force = false) {
    if (!this._dirty && !force) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.warn(`[store] could not persist ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { Store, DEFAULT_FILE };
