'use strict';

// store.js — identity + play counts. In-memory Map with a JSON snapshot so the
// standings survive a restart mid-party.
//
// Identity is keyed on a device fingerprint sent by the guest page. In this
// build the fingerprint is generated client-side and kept in localStorage, so it
// is FORGEABLE by clearing browser storage. That is an accepted limit for a
// party (see README "Known honest limits").
//
// FUTURE — evasion-resistant identity (not built this pass):
//   Bind the fingerprint server-side on first visit. On the guest's first HTTP
//   hit, mint a random token, set it as an httpOnly + SameSite=Strict cookie,
//   and store token->fp here. Thereafter trust the cookie, not the client-sent
//   fingerprint. Clearing localStorage then does nothing; the guest would have
//   to clear cookies (and even then we can rate-limit fresh identities per IP).
//   Keep that mapping in this module so the rest of the system stays unaware of
//   how identity is established.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'store.snapshot.json');

class Store {
  /** @param {string} [file] snapshot path; defaults to STORE_FILE or store.snapshot.json */
  constructor(file) {
    this.file = file || process.env.STORE_FILE || DEFAULT_FILE;
    /** @type {Map<string,{name:string, played:number, firstSeen:number}>} */
    this.people = new Map();
    this._dirty = false;
  }

  /** Ensure a fingerprint exists; update its display name. Returns the record. */
  ensure(fp, name) {
    let rec = this.people.get(fp);
    if (!rec) {
      rec = { name: name || 'guest', played: 0, firstSeen: Date.now() };
      this.people.set(fp, rec);
      this._dirty = true;
    } else if (name && name !== rec.name) {
      rec.name = name;
      this._dirty = true;
    }
    return rec;
  }

  /** Increment lifetime play count for a fingerprint. */
  recordPlay(fp) {
    const rec = this.ensure(fp);
    rec.played += 1;
    this._dirty = true;
    return rec.played;
  }

  /** Lifetime play count for a fingerprint (0 if unknown). */
  played(fp) {
    const rec = this.people.get(fp);
    return rec ? rec.played : 0;
  }

  get(fp) {
    return this.people.get(fp);
  }

  /** Snapshot of all records as a plain object keyed by fingerprint. */
  all() {
    const out = {};
    for (const [fp, rec] of this.people) out[fp] = { ...rec };
    return out;
  }

  /** Load the snapshot from disk if present. Safe to call when the file is absent. */
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.people = new Map(Object.entries(data));
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
