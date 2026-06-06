'use strict';

// server.js — wires the modules together and dual-logs everything.
//
// Two front-end MODES, same back end (fairshare + store + kfadapter + the
// player control link that does the reordering):
//
//   MODE=page  (default)  our own guest page + ws protocol:
//       [guest phones] --ws--> [server.js] --ws--> [KaraFun player]
//
//   MODE=proxy            reverse-proxy KaraFun's own web UI through us, so the
//       QR points at THIS box and guests get KaraFun's UI while we fingerprint
//       each session server-side (httpOnly token + IP) and observe/reorder:
//       [guest phones] --http--> [server.js @ this box] --http--> [KARAFUN_UI_URL]
//                                      `--ws--> [KaraFun player]  (reordering)
//
// We bind on all interfaces (0.0.0.0), so the guest-facing URL is just this
// machine's own LAN IP on GUEST_PORT — printed at boot, nothing hardcoded.
//
// OBSERVE MODE (default): compute the order we *would* apply and LOG it; never
// mutate the player's queue and never alter proxied bodies. Flip OBSERVE=0 only
// after the probe confirms the real frame/request shapes.

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const fairshare = require('./fairshare');
const kfadapter = require('./kfadapter');
const rewrite = require('./rewrite');
const { Store } = require('./store');
const { Correlator } = require('./correlate');

// QR rendering for the dashboard — optional: if the dep is missing the
// dashboard simply shows the URL as text instead of a code.
let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { /* optional */ }

// ---- config ---------------------------------------------------------------
const PLAYER_URL = process.env.PLAYER_URL || 'ws://localhost:57570';
const GUEST_PORT = parseInt(process.env.GUEST_PORT || '8080', 10);
const WEIGHT = parseFloat(process.env.WEIGHT || '1.0');
const OBSERVE = process.env.OBSERVE !== '0'; // default ON (safe)
const COOKIE_NAME = process.env.COOKIE_NAME || 'kffp';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // empty = open on the LAN
const PUBLIC_DIR = path.join(__dirname, 'public');

// Proxy upstream + the "room" path guests must land on.
//   KARAFUN_ROOM_URL = the exact link KaraFun says to join, e.g.
//     https://www.karafun.com/000000   or   http://<player-ip>:<port>/<code>
//   We proxy to its ORIGIN and carry its PATH into the QR, so a guest who scans
//   http://<our-ip>:<port>/<code> lands on KaraFun's room *through us* — the QR
//   is just KaraFun's room link with the host swapped to this proxy.
//   Setting KARAFUN_ROOM_URL also flips the default start into MITM proxy mode.
const KARAFUN_ROOM_URL = process.env.KARAFUN_ROOM_URL || '';
const KARAFUN_UI_URL = process.env.KARAFUN_UI_URL || ''; // optional origin override
let UPSTREAM = KARAFUN_UI_URL; // origin we reverse-proxy to
let JOIN_PATH = process.env.JOIN_PATH || '/'; // path the QR carries through us
if (KARAFUN_ROOM_URL) {
  try {
    const r = new URL(KARAFUN_ROOM_URL);
    UPSTREAM = KARAFUN_UI_URL || `${r.protocol}//${r.host}`;
    JOIN_PATH = (r.pathname || '/') + (r.search || '');
  } catch (_) {
    console.error(`[boot] invalid KARAFUN_ROOM_URL: ${KARAFUN_ROOM_URL}`);
  }
}
// Room link present => MITM proxy is the obvious intent, so default start to it.
const MODE = (process.env.MODE || (KARAFUN_ROOM_URL ? 'proxy' : 'page')).toLowerCase();

// Cloud rewriting: rewrite upstream-host URLs in HTML/JS/JSON (+ the ws URL) so
// the SPA's traffic routes back through us. Needed only when the room is the
// karafun.com cloud SPA (World C); a no-op cost for local UIs, so off by default.
const REWRITE = process.env.REWRITE === '1';
let UPSTREAM_HOST = '';
try { if (UPSTREAM) UPSTREAM_HOST = new URL(UPSTREAM).host; } catch (_) { /* set at boot warn */ }

// ---- state ----------------------------------------------------------------
const store = new Store().load();
const correlator = new Correlator(); // proxy mode: add-time -> queue-entry binding
let seqCounter = 0;
/** @type {Array<{id:*, fp:string, seq:number, title:string, singerName:string}>} */
let pending = [];
/** guest socket -> { fp }  (page mode only) */
const guests = new Map();

// ---- dual logging (console + in-memory ring buffer for download) ----------
const LOG_CAP = 3000;
const logBuffer = [];
const safeStr = (a) => { try { return JSON.stringify(a); } catch (_) { return String(a); } };

function log(tag, ...args) {
  const stamp = new Date().toISOString().slice(11, 23);
  const msg = args.map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' ');
  const line = `${stamp} ${tag} ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > LOG_CAP) logBuffer.shift();
}

// ---- diagnostics: is attribution actually working? ------------------------
// Counters + recent feeds that answer "can we identify who selected what song?"
// Surfaced live on the dashboard and in the downloadable diagnostic bundle.
const diag = {
  startedAt: Date.now(),
  proxyRequests: 0,
  searchesSeen: 0,
  addsSeen: 0,        // add-shaped requests observed
  addsWithSong: 0,    // ...where we parsed a title/songId
  queueFramesSeen: 0,
  queueEntriesSeen: 0,        // distinct queue rows ever seen
  queueEntriesWithSinger: 0,  // ...that carried a singerName from KaraFun
  correlated: 0,      // add bound to a queue row (who↔what)
  unattributed: 0,    // queue rows we couldn't tie to anyone
  playsAttributed: 0,
  playsUnattributed: 0,
  rewrites: 0,        // upstream textual responses rewritten (cloud mode)
  recentAdds: [],     // { t, fp, song }
  recentBinds: [],    // { t, entryId, fp, title }
  recentPlays: [],    // { t, fp, title }
};
const diagSeenEntries = new Set(); // queue ids counted once
function pushRecent(arr, item, cap = 20) { arr.push(item); if (arr.length > cap) arr.shift(); }

// Verdict: do we have a working who↔what link? Either KaraFun names the singer
// in the queue, or we've bound at least one add to its resulting row.
function canIdentify() {
  return diag.correlated > 0 || diag.queueEntriesWithSinger > 0;
}

// This machine's non-internal IPv4 address(es). The guest-facing URL is just
// one of these on GUEST_PORT — no IP is ever hardcoded; we detect it at boot.
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// The guest-facing URL for an IP — this proxy's address plus the room path, so
// the QR is KaraFun's join link rehosted on us. Port 80 is dropped so it reads
// as a bare http://<ip>[/room], matching how a browser normalizes it.
function guestUrl(ip) {
  const base = GUEST_PORT === 80 ? `http://${ip}` : `http://${ip}:${GUEST_PORT}`;
  return JOIN_PATH && JOIN_PATH !== '/' ? base + JOIN_PATH : base;
}

// All guest entry-point URLs (this machine's LAN IP(s) on GUEST_PORT).
function guestUrls() {
  return lanIPs().map(guestUrl);
}

// Print the URL(s) guests/QR should hit — this machine's actual LAN IP(s).
function logGuestUrls() {
  const urls = guestUrls();
  if (urls.length === 0) {
    log('boot', `guests:      ${guestUrl('<this-machine-ip>')}   <-- the QR encodes this`);
    return;
  }
  urls.forEach((u, i) =>
    log('boot', `guests:      ${u}${i === 0 ? '   <-- the dashboard QR encodes this' : ''}`));
}

// ---- ordering + standings -------------------------------------------------
function playedOf(fp) {
  return store.played(fp);
}

function currentOrder() {
  return fairshare.order(pending, playedOf, WEIGHT);
}

// Recompute fair-share order and (observe) log what we WOULD apply. When live,
// drive the player queue toward the computed order via kfadapter.moveTo.
function reconcile(reason) {
  // annotate() exposes the score breakdown so observe mode shows *why* the
  // order is what it is. It's a superset of order(): same ordering, extra fields.
  const ordered = fairshare.annotate(pending, playedOf, WEIGHT);
  log('ORDER', `(${reason})`);
  if (ordered.length === 0) {
    log('     ', '(empty)');
  } else {
    ordered.forEach((e) =>
      log('     ',
        `#${e._position + 1} "${e.title}" by ${e.singerName} ` +
        `[played=${e._played} pendingAhead=${e._pendingAhead} score=${e._score}]`));
  }

  if (OBSERVE) {
    ordered.forEach((e, idx) => {
      const action = kfadapter.moveTo(playerSend, e.id, idx, true);
      log('WOULD', `move id=${e.id} -> #${idx + 1}`, action.frames[0]);
    });
  } else {
    ordered.forEach((e, idx) => kfadapter.moveTo(playerSend, e.id, idx, false));
  }

  broadcastStandings(ordered);
  broadcastAdmin();
}

// Push each page-mode guest their live standing. In proxy mode the guest UI is
// KaraFun's, so there's no socket to push to — standings stay observe-only logs.
function broadcastStandings(ordered) {
  ordered = ordered || currentOrder();
  for (const [ws, meta] of guests) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const mine = ordered.filter((e) => e.fp === meta.fp);
    const next = ordered.find((e) => e.fp === meta.fp);
    const position = next ? ordered.indexOf(next) + 1 : null;
    send(ws, {
      type: 'standing',
      position,
      ahead: position ? position - 1 : null,
      yours: mine.map((e) => ({ id: e.id, title: e.title })),
      queueLength: ordered.length,
      played: store.played(meta.fp),
    });
  }
}

// Add a song to our pending view on behalf of a fingerprint, then reconcile.
// Shared by page mode (explicit ws 'add') and proxy mode (sniffed add).
function addSong(fp, title) {
  const rec = store.get(fp);
  const entry = {
    id: ++seqCounter, // doubles as a stable per-night id and FIFO seq source
    fp,
    seq: seqCounter,
    title: title || `song ${seqCounter}`,
    singerName: rec ? rec.name : 'guest',
  };
  pending.push(entry);
  // Page mode (or proxy-live): who + what are known at add time — full attribution.
  diag.addsSeen += 1;
  diag.addsWithSong += 1;
  diag.correlated += 1;
  pushRecent(diag.recentAdds, { t: Date.now(), fp: short(fp), song: entry.title });
  pushRecent(diag.recentBinds, { t: Date.now(), entryId: entry.id, fp: short(fp), title: entry.title });
  reconcile(`add ${entry.singerName}:${entry.title}`);
  return entry;
}

// ---- server-side identity (proxy mode): httpOnly token + IP --------------
// The token IS the fingerprint key. Because it's httpOnly and server-minted, a
// guest can't forge a fresh identity by editing a field — they'd have to drop
// the cookie. This is the evasion-resistant binding flagged in store.js, now
// actually built (only wired in proxy mode, where we control the responses).
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function identify(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) return { fp: token, minted: null };
  const fresh = crypto.randomBytes(16).toString('hex');
  // Set on the eventual response (appended in proxyRes). SameSite=Lax is enough
  // for a same-origin LAN page; HttpOnly keeps JS from reading/forging it.
  const cookie = `${COOKIE_NAME}=${fresh}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
  return { fp: fresh, minted: cookie };
}

const short = (fp) => (fp ? String(fp).slice(0, 8) : '?');

// Normalized client IP (strip the IPv4-mapped-IPv6 prefix). Used to spot when
// several fingerprints share one device IP — the signature of a guest clearing
// browser storage to mint a fresh identity.
function clientIp(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra.replace(/^::ffff:/, '');
}

// Buffer a request body so we can inspect it (an add's song) AND still forward
// it to upstream — http-proxy re-streams from the buffer we hand it, so the
// proxy stays byte-for-byte transparent.
function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function streamFrom(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

// ---- player websocket client (tolerant; must not crash if absent) ---------
let player = null;
let playerBackoff = 1000;
const MAX_BACKOFF = 30000;

function playerSend(frame) {
  if (player && player.readyState === WebSocket.OPEN) {
    player.send(frame);
    log('→player', frame);
  } else {
    log('→player', '(no player connected, dropped)', frame);
  }
}

function connectPlayer() {
  log('player', `connecting to ${PLAYER_URL} ...`);
  let ws;
  try {
    ws = new WebSocket(PLAYER_URL);
  } catch (err) {
    return scheduleReconnect(`construct failed: ${err.message}`);
  }
  player = ws;

  ws.on('open', () => {
    playerBackoff = 1000;
    log('player', 'connected');
    broadcastAdmin(); // reflect connected state on dashboards
  });

  ws.on('message', (data) => {
    const evt = kfadapter.parseInbound(data);
    log('player→', `[${evt.type}]`, data.toString());

    // GATING UNKNOWN #1: what a queue frame looks like (observe — log shape).
    const q = kfadapter.parseQueue(evt.json || {});
    if (q.length) {
      log('player', `queue frame: ${q.length} entries; singerName present on`,
        `${q.filter((e) => e.singerName).length}/${q.length}`);
      handleQueueFrame(q);
    }

    // GATING UNKNOWN #3: catalog results over the same socket (observe — log).
    const cat = kfadapter.parseCatalog(evt.json || {});
    if (cat) log('player', `catalog frame: ${cat.length} results`);

    // GATING UNKNOWN #2: song-finished attribution.
    const fin = kfadapter.detectFinished(evt.json || {});
    if (fin) attributeFinish(fin);
  });

  ws.on('close', () => scheduleReconnect('closed'));
  ws.on('error', (err) => {
    // Expected during the first observe run when no player is listening.
    log('player', `error: ${err.message}`);
  });
}

function scheduleReconnect(why) {
  player = null;
  broadcastAdmin(); // reflect offline state on dashboards
  const delay = playerBackoff;
  playerBackoff = Math.min(playerBackoff * 2, MAX_BACKOFF);
  log('player', `${why}; reconnecting in ${delay}ms`);
  setTimeout(connectPlayer, delay).unref();
}

// Map an observed player-queue frame to our pending model. In proxy mode the
// queue truth is KaraFun's, so we attribute each entry to a fingerprint —
// preferring a previous binding, else a name the protocol gave us, else a
// timing correlation against recent proxied adds — and mirror it into pending
// so fairshare can order it and reconcile can reorder it.
function handleQueueFrame(entries) {
  diag.queueFramesSeen += 1;
  for (const e of entries) {
    if (!diagSeenEntries.has(e.id)) {
      diagSeenEntries.add(e.id);
      diag.queueEntriesSeen += 1;
      if (e.singerName) diag.queueEntriesWithSinger += 1;
    }
  }
  if (MODE !== 'proxy') return; // page mode is authoritative over its own pending
  const now = Date.now();
  let changed = false;
  for (const e of entries) {
    let fp = correlator.fpForEntry(e.id);
    if (!fp) fp = correlator.attachEntry(e.id, now);
    if (!fp) { diag.unattributed += 1; continue; } // leave it for a later frame
    if (!pending.some((p) => p.id === e.id)) {
      const rec = store.get(fp);
      pending.push({
        id: e.id,
        fp,
        seq: ++seqCounter,
        title: e.title || `song ${seqCounter}`,
        singerName: rec ? rec.name : 'guest',
      });
      diag.correlated += 1;
      pushRecent(diag.recentBinds, { t: now, entryId: e.id, fp: short(fp), title: e.title || null });
      log('correlate', `queue entry ${e.id} -> fp=${short(fp)} (${e.title || '?'})`);
      changed = true;
    }
  }
  if (changed) reconcile('queue update');
}

// Attribute a finished song to a fingerprint and bump its play count.
function attributeFinish(fin) {
  // Prefer the entry mapping we already hold (matches by id we assigned).
  let entry = pending.find((e) => e.id === fin.finishedId);
  if (!entry && fin.singer) {
    // Fallback: match by the singer name the finished-frame reported.
    entry = pending.find((e) => e.singerName === fin.singer);
  }
  // Last resort: the timing correlation bound this entry id to a fingerprint.
  const fp = entry ? entry.fp
    : (fin.finishedId != null ? correlator.fpForEntry(fin.finishedId) : null);

  if (fp) {
    store.recordPlay(fp);
    diag.playsAttributed += 1;
    pushRecent(diag.recentPlays, { t: Date.now(), fp: short(fp), title: entry ? entry.title : null });
    if (entry) pending = pending.filter((e) => e.id !== entry.id);
    if (fin.finishedId != null) correlator.forget(fin.finishedId);
    store.persist();
    log('PLAY', `recorded for ${short(fp)}${entry ? ` (${entry.title})` : ''}`);
    reconcile('song finished');
  } else {
    diag.playsUnattributed += 1;
    log('PLAY', 'finished frame could not be attributed', JSON.stringify(fin));
  }
}

// ---- operator dashboard (both modes) --------------------------------------
// A small monitor at /__admin with a "reset stats" button. The double-underscore
// path avoids colliding with KaraFun's own routes when proxying.
function adminAuthed(req) {
  if (!ADMIN_TOKEN) return true; // open on a trusted LAN
  return (req.query.t || req.headers['x-admin-token']) === ADMIN_TOKEN;
}

function adminState() {
  const ordered = fairshare.annotate(pending, playedOf, WEIGHT);
  const all = store.all();
  // Count distinct fingerprints per IP — >1 suggests a device that cleared
  // storage to mint a fresh identity (same IP, new fingerprint).
  const idsPerIp = {};
  for (const r of Object.values(all)) {
    if (r.lastIp) idsPerIp[r.lastIp] = (idsPerIp[r.lastIp] || 0) + 1;
  }
  const people = Object.entries(all)
    .map(([fp, r]) => ({
      fp: String(fp).slice(0, 8),
      name: r.name,
      played: r.played,
      lastIp: r.lastIp || null,
      idsAtIp: r.lastIp ? idsPerIp[r.lastIp] : 1,
      sharedIp: !!(r.lastIp && idsPerIp[r.lastIp] > 1),
      firstSeen: r.firstSeen,
    }))
    .sort((a, b) => b.played - a.played || a.firstSeen - b.firstSeen);
  const ipsShared = Object.values(idsPerIp).filter((c) => c > 1).length;

  return {
    mode: MODE,
    observe: OBSERVE,
    weight: WEIGHT,
    port: GUEST_PORT,
    guestUrls: guestUrls(), // this machine's LAN IP(s) + room path — the QR
    qr: !!QRCode,
    upstream: MODE === 'proxy' ? (UPSTREAM || null) : null,
    rewrite: MODE === 'proxy' ? REWRITE : null,
    roomUrl: KARAFUN_ROOM_URL || null,
    joinPath: JOIN_PATH,
    playerConnected: !!(player && player.readyState === WebSocket.OPEN),
    pendingAdds: correlator.pendingAdds(),
    diag: { ...diag, canIdentify: canIdentify() },
    ipsShared,
    queue: ordered.map((e) => ({
      id: e.id,
      position: e._position + 1,
      title: e.title,
      singer: e.singerName,
      fp: String(e.fp).slice(0, 8),
      played: e._played,
      pendingAhead: e._pendingAhead,
      score: e._score,
    })),
    people,
  };
}

function installAdmin(app) {
  // Registered before the static/proxy catch-all so these win.
  app.get('/__admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.get('/__admin/state', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).json({ error: 'bad admin token' });
    res.json(adminState());
  });
  app.post('/__admin/reset', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).json({ error: 'bad admin token' });
    const n = store.resetStats();
    store.persist(true);
    log('admin', `stats reset — ${n} people zeroed`);
    reconcile('admin reset'); // reconcile() pushes the new state to dashboards
    res.json({ ok: true, reset: n });
  });
  // Downloadable diagnostic bundle — hand this back for fixing the protocol
  // stubs. Includes config, the live diagnostics/verdict, current state, and the
  // captured observe log.
  app.get('/__admin/log', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).end();
    const bundle = {
      generatedAt: new Date().toISOString(),
      note: 'KaraFun fair-share observe-mode diagnostic capture. Send this back to fill in the kfadapter stubs (queue/finished/add/search shapes).',
      config: {
        mode: MODE, observe: OBSERVE, weight: WEIGHT, guestPort: GUEST_PORT,
        playerUrl: PLAYER_URL, upstream: UPSTREAM || null,
        roomUrl: KARAFUN_ROOM_URL || null, joinPath: JOIN_PATH,
      },
      state: adminState(), // includes diagnostics + verdict + queue + people
      log: logBuffer.slice(),
    };
    const fname = `karafun-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.type('application/json').send(JSON.stringify(bundle, null, 2));
  });

  // QR for the guest/proxy URL, rendered as SVG (scales crisply, no binary).
  app.get('/__admin/qr', (req, res) => {
    if (!adminAuthed(req)) return res.status(403).end();
    if (!QRCode) return res.status(501).type('text/plain').send('qrcode not installed');
    const url = String(req.query.url || guestUrls()[0] || guestUrl('localhost'));
    QRCode.toString(url, { type: 'svg', margin: 1 }, (err, svg) => {
      if (err) return res.status(500).end();
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    });
  });
}

// Dashboard live channel: push adminState() to connected operators on every
// change, so the page never polls. noServer + path-routed upgrade so it coexists
// with the guest ws (page mode) and the proxied ws (proxy mode).
const adminWss = new WebSocketServer({ noServer: true });
const adminClients = new Set();

adminWss.on('connection', (ws) => {
  adminClients.add(ws);
  log('admin', 'dashboard connected');
  try { ws.send(JSON.stringify({ type: 'state', ...adminState() })); } catch (_) {}
  ws.on('close', () => adminClients.delete(ws));
  ws.on('error', () => adminClients.delete(ws));
});

function broadcastAdmin() {
  if (!adminClients.size) return;
  const payload = JSON.stringify({ type: 'state', ...adminState() });
  for (const ws of adminClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch (_) { /* closing */ }
    }
  }
}

// Route an http 'upgrade' for the dashboard ws; returns true if it handled it.
function handleAdminUpgrade(req, socket, head) {
  let pathname, searchParams;
  try { ({ pathname, searchParams } = new URL(req.url, 'http://localhost')); }
  catch (_) { return false; }
  if (pathname !== '/__admin/ws') return false;
  if (ADMIN_TOKEN && searchParams.get('t') !== ADMIN_TOKEN) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return true;
  }
  adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit('connection', ws, req));
  return true;
}

// ---- front end A: our own page (page mode) --------------------------------
function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (_) {
    /* socket closing */
  }
}

function handleGuestMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return send(ws, { type: 'error', error: 'bad json' });
  }
  log('guest→', msg.type, JSON.stringify(msg));

  switch (msg.type) {
    case 'join': {
      const fp = String(msg.fp || '').trim();
      const name = String(msg.name || 'guest').trim().slice(0, 40);
      if (!fp) return send(ws, { type: 'error', error: 'missing fingerprint' });
      store.ensure(fp, name, ws._ip);
      guests.set(ws, { fp, ip: ws._ip });
      store.persist();
      send(ws, { type: 'joined', fp, name, observe: OBSERVE });
      broadcastStandings();
      break;
    }

    case 'add': {
      const meta = guests.get(ws);
      if (!meta) return send(ws, { type: 'error', error: 'join first' });
      const title = String(msg.title || '').trim().slice(0, 120);
      if (!title) return send(ws, { type: 'error', error: 'missing title' });
      const entry = addSong(meta.fp, title);
      send(ws, { type: 'added', id: entry.id, title });
      break;
    }

    case 'search': {
      // GATING UNKNOWN #3: search over the player socket. Observe = log intent.
      const query = String(msg.query || '').trim().slice(0, 120);
      const frame = kfadapter.buildSearch(query);
      if (OBSERVE) {
        log('WOULD', 'search', frame);
        send(ws, { type: 'searchResults', query, results: [], observe: true });
      } else {
        playerSend(frame);
        // real results arrive asynchronously on the player socket (TODO: route)
      }
      break;
    }

    case 'leave': {
      guests.delete(ws);
      break;
    }

    default:
      send(ws, { type: 'error', error: `unknown type ${msg.type}` });
  }
}

function startPageFrontend() {
  const app = express();
  installAdmin(app);
  app.use(express.static(PUBLIC_DIR));
  const httpServer = http.createServer(app);

  const guestWss = new WebSocketServer({ noServer: true });
  guestWss.on('connection', (ws, req) => {
    ws._ip = clientIp(req);
    log('guest', `connected from ${ws._ip}`);
    ws.on('message', (raw) => handleGuestMessage(ws, raw.toString()));
    ws.on('close', () => {
      guests.delete(ws);
      log('guest', 'disconnected');
    });
    ws.on('error', (err) => log('guest', `error: ${err.message}`));
  });

  // Route upgrades: dashboard ws -> adminWss, everything else -> guest ws.
  httpServer.on('upgrade', (req, socket, head) => {
    if (handleAdminUpgrade(req, socket, head)) return;
    guestWss.handleUpgrade(req, socket, head, (ws) => guestWss.emit('connection', ws, req));
  });

  httpServer.listen(GUEST_PORT, () => {
    log('boot', `MODE=page  OBSERVE=${OBSERVE ? 1 : 0}  weight=${WEIGHT}`);
    logGuestUrls();
    log('boot', `dashboard:   http://localhost:${GUEST_PORT}/__admin   (on this machine)`);
    log('boot', `player url:  ${PLAYER_URL}`);
    if (OBSERVE) log('boot', 'observe mode — nothing will be sent to the player');
    connectPlayer();
  });
}

// ---- front end B: reverse-proxy KaraFun's web UI (proxy mode) -------------
function startProxyFrontend() {
  // http-proxy is only needed in this mode, so require it lazily.
  const httpProxy = require('http-proxy');

  if (!UPSTREAM) {
    log('boot', 'WARNING: MODE=proxy but no upstream set.');
    log('boot', '  Give it the link KaraFun says guests should join, e.g.:');
    log('boot', '  KARAFUN_ROOM_URL="https://www.karafun.com/000000" npm start');
    log('boot', '  (or KARAFUN_UI_URL=http://<player-ip>:<port> for a local UI)');
  }

  const proxy = httpProxy.createProxyServer({
    target: UPSTREAM || 'http://127.0.0.1:1', // dummy => visible 502 until set
    changeOrigin: true,        // send upstream's Host
    ws: true,                  // proxy the realtime channel too
    autoRewrite: true,         // rewrite redirect Location host -> us
    cookieDomainRewrite: '',   // scope upstream cookies to our origin
    xfwd: true,
    selfHandleResponse: REWRITE, // we write the response ourselves when rewriting
  });

  // Cloud mode: ask upstream for uncompressed bodies (so we can rewrite them) and
  // present the upstream's own Origin/Referer (CSRF/WS origin checks).
  proxy.on('proxyReq', (proxyReq, req) => {
    if (!REWRITE) return;
    proxyReq.setHeader('accept-encoding', 'identity');
    if (UPSTREAM) proxyReq.setHeader('origin', UPSTREAM);
    const ref = req.headers.referer;
    if (ref && UPSTREAM) {
      try { const u = new URL(ref); proxyReq.setHeader('referer', UPSTREAM + u.pathname + u.search); }
      catch (_) { /* leave as-is */ }
    }
  });

  const cookieFor = (req) => (req._kfMinted ? [req._kfMinted] : []);

  proxy.on('proxyRes', (proxyRes, req, res) => {
    // No rewriting: http-proxy pipes the body; we only append our cookie header.
    if (!REWRITE) {
      const extra = cookieFor(req);
      if (extra.length) {
        const prev = proxyRes.headers['set-cookie'] || [];
        proxyRes.headers['set-cookie'] = [].concat(prev, extra);
      }
      return;
    }

    // Rewriting (selfHandleResponse): we own the response.
    const headers = { ...proxyRes.headers };
    const extra = cookieFor(req);
    if (extra.length) headers['set-cookie'] = [].concat(headers['set-cookie'] || [], extra);

    // Binary / non-text: stream straight through unchanged.
    if (!rewrite.isTextual(proxyRes.headers['content-type'])) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }

    // Textual: buffer, rewrite upstream-host URLs -> our host, resend.
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const ourHost = req.headers.host;
      const body = rewrite.rewriteBody(Buffer.concat(chunks).toString('utf8'),
        { upstreamHost: UPSTREAM_HOST, ourHost });
      const buf = Buffer.from(body, 'utf8');
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = Buffer.byteLength(buf);
      diag.rewrites += 1;
      res.writeHead(proxyRes.statusCode, headers);
      res.end(buf);
    });
  });

  proxy.on('error', (err, req, res) => {
    log('proxy', `upstream error: ${err.message}`);
    if (res && res.writeHead && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('upstream (KARAFUN_UI_URL) unreachable');
    }
  });

  const app = express();
  installAdmin(app); // our dashboard wins over the proxy catch-all

  // Identity + observe middleware — runs BEFORE proxying, never alters the body.
  app.use((req, res, next) => {
    const { fp, minted } = identify(req);
    if (minted) req._kfMinted = minted;
    const ip = clientIp(req);
    store.ensure(fp, store.get(fp)?.name || `guest@${ip}`, ip);

    // GATING UNKNOWN: KaraFun web-UI request shapes. sniffWeb is best-effort.
    diag.proxyRequests += 1;
    const sniff = kfadapter.sniffWeb(req.method, req.url);
    const who = `fp=${short(fp)}${minted ? '(new)' : ''} ip=${ip}`;

    if (sniff.kind !== 'add') {
      if (sniff.kind === 'search') diag.searchesSeen += 1;
      log('proxy→', `${req.method} ${req.url}  ${sniff.kind === 'other' ? '' : `:: ${sniff.kind} `}(${who})`);
      return next();
    }

    // An add: capture WHAT was requested. GET carries it in the query; bodies
    // are buffered then re-streamed so the proxied request still has its body.
    const finish = (body) => {
      if (body != null) req._kfBody = body; // forwarded to upstream verbatim
      const info = kfadapter.parseAddRequest(req.method, req.url, req.headers['content-type'], body);
      correlator.recordAdd(fp, Date.now(), info.title);
      diag.addsSeen += 1;
      if (info.title || info.songId) diag.addsWithSong += 1;
      const song = info.title || (info.songId ? `#${info.songId}` : '?');
      pushRecent(diag.recentAdds, { t: Date.now(), fp: short(fp), song });
      log(OBSERVE ? 'WOULD' : 'add',
        `add by ${short(fp)} :: "${song}" — binds to its next queue entry  (${who})`);
      next();
    };

    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    if (!hasBody) return finish(null);
    bufferBody(req).then(finish).catch(() => finish(null));
  });

  // Forward to upstream. If we buffered an add body, re-stream it so the request
  // upstream is identical — guests get exactly KaraFun's page either way.
  app.use((req, res) => {
    const opts = req._kfBody != null ? { buffer: streamFrom(req._kfBody) } : undefined;
    proxy.web(req, res, opts);
  });

  const httpServer = http.createServer(app);

  // Route upgrades: dashboard ws -> adminWss, everything else -> upstream.
  httpServer.on('upgrade', (req, socket, head) => {
    if (handleAdminUpgrade(req, socket, head)) return;
    log('proxy', `ws upgrade ${req.url} -> upstream`);
    // Present the upstream's Origin on the ws handshake when rewriting (cloud).
    proxy.ws(req, socket, head, REWRITE && UPSTREAM ? { headers: { origin: UPSTREAM } } : undefined);
  });

  httpServer.listen(GUEST_PORT, () => {
    log('boot', `MODE=proxy  OBSERVE=${OBSERVE ? 1 : 0}  weight=${WEIGHT}`);
    logGuestUrls();
    log('boot', `dashboard:   http://localhost:${GUEST_PORT}/__admin   (on this machine)`);
    log('boot', `upstream:    ${UPSTREAM || '(UNSET — set KARAFUN_ROOM_URL)'}`);
    if (KARAFUN_ROOM_URL) log('boot', `room link:   ${KARAFUN_ROOM_URL}  (rehosted via the QR above)`);
    log('boot', `rewrite:     ${REWRITE ? `ON — rewriting ${UPSTREAM_HOST} URLs/ws to this host (cloud SPA)` : 'off (local UI — set REWRITE=1 for a cloud room)'}`);
    log('boot', `player ctrl: ${PLAYER_URL}`);
    log('boot', `identity:    httpOnly '${COOKIE_NAME}' token (server-pinned) + source IP`);
    if (GUEST_PORT !== 80) {
      log('boot', `note: for a bare "http://<ip>/" QR, run with GUEST_PORT=80 (needs privilege)`);
    }
    if (OBSERVE) log('boot', 'observe mode — proxy + fingerprint + log only; no reorder, bodies untouched');
    connectPlayer();
  });
}

// ---- front end selection --------------------------------------------------
if (MODE === 'proxy') startProxyFrontend();
else startPageFrontend();

// ---- lifecycle (shared) ---------------------------------------------------
// Persist periodically and on exit so standings survive a restart.
const persistTimer = setInterval(() => store.persist(), 15000);
persistTimer.unref();

// Dashboard heartbeat — catches anything not already pushed (e.g. pendingAdds
// ticking down). No-op when no operator is watching.
const adminBeat = setInterval(broadcastAdmin, 3000);
adminBeat.unref();

function shutdown() {
  log('boot', 'shutting down, persisting store');
  store.persist(true);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { reconcile, currentOrder, addSong }; // exported for potential tests
