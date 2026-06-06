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
//       [guest phones] --http--> [server.js @ .42] --http--> [KARAFUN_UI_URL]
//                                      `--ws--> [KaraFun player]  (reordering)
//
// OBSERVE MODE (default): compute the order we *would* apply and LOG it; never
// mutate the player's queue and never alter proxied bodies. Flip OBSERVE=0 only
// after the probe confirms the real frame/request shapes.

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const fairshare = require('./fairshare');
const kfadapter = require('./kfadapter');
const { Store } = require('./store');

// ---- config ---------------------------------------------------------------
const MODE = (process.env.MODE || 'page').toLowerCase(); // 'page' | 'proxy'
const PLAYER_URL = process.env.PLAYER_URL || 'ws://localhost:57570';
const KARAFUN_UI_URL = process.env.KARAFUN_UI_URL || ''; // upstream for proxy mode
const GUEST_PORT = parseInt(process.env.GUEST_PORT || '8080', 10);
const WEIGHT = parseFloat(process.env.WEIGHT || '1.0');
const OBSERVE = process.env.OBSERVE !== '0'; // default ON (safe)
const COOKIE_NAME = process.env.COOKIE_NAME || 'kffp';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- state ----------------------------------------------------------------
const store = new Store().load();
let seqCounter = 0;
/** @type {Array<{id:number, fp:string, seq:number, title:string, singerName:string}>} */
let pending = [];
/** guest socket -> { fp }  (page mode only) */
const guests = new Map();

// ---- dual logging ---------------------------------------------------------
function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${ts} ${tag}`, ...args);
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
  });

  ws.on('message', (data) => {
    const evt = kfadapter.parseInbound(data);
    log('player→', `[${evt.type}]`, data.toString());

    // GATING UNKNOWN #1: what a queue frame looks like (observe — log shape).
    const q = kfadapter.parseQueue(evt.json || {});
    if (q.length) {
      log('player', `queue frame: ${q.length} entries; singerName present on`,
        `${q.filter((e) => e.singerName).length}/${q.length}`);
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
  const delay = playerBackoff;
  playerBackoff = Math.min(playerBackoff * 2, MAX_BACKOFF);
  log('player', `${why}; reconnecting in ${delay}ms`);
  setTimeout(connectPlayer, delay).unref();
}

// Attribute a finished song to a fingerprint and bump its play count.
function attributeFinish(fin) {
  // Prefer the entry mapping we already hold (matches by id we assigned).
  let entry = pending.find((e) => e.id === fin.finishedId);
  if (!entry && fin.singer) {
    // Fallback: match by the singer name the finished-frame reported.
    entry = pending.find((e) => e.singerName === fin.singer);
  }
  if (entry) {
    store.recordPlay(entry.fp);
    pending = pending.filter((e) => e.id !== entry.id);
    store.persist();
    log('PLAY', `recorded for ${entry.singerName} (${entry.title})`);
    reconcile('song finished');
  } else {
    log('PLAY', 'finished frame could not be attributed', JSON.stringify(fin));
  }
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
      store.ensure(fp, name);
      guests.set(ws, { fp });
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
  app.use(express.static(PUBLIC_DIR));
  const httpServer = http.createServer(app);

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    log('guest', 'connected');
    ws.on('message', (raw) => handleGuestMessage(ws, raw.toString()));
    ws.on('close', () => {
      guests.delete(ws);
      log('guest', 'disconnected');
    });
    ws.on('error', (err) => log('guest', `error: ${err.message}`));
  });

  httpServer.listen(GUEST_PORT, () => {
    log('boot', `MODE=page  OBSERVE=${OBSERVE ? 1 : 0}  weight=${WEIGHT}`);
    log('boot', `guest page:  http://localhost:${GUEST_PORT}`);
    log('boot', `player url:  ${PLAYER_URL}`);
    if (OBSERVE) log('boot', 'observe mode — nothing will be sent to the player');
    connectPlayer();
  });
}

// ---- front end B: reverse-proxy KaraFun's web UI (proxy mode) -------------
function startProxyFrontend() {
  // http-proxy is only needed in this mode, so require it lazily.
  const httpProxy = require('http-proxy');

  if (!KARAFUN_UI_URL) {
    log('boot', 'WARNING: MODE=proxy but KARAFUN_UI_URL is empty.');
    log('boot', '  Set it to the KaraFun web UI the probe revealed, e.g.');
    log('boot', '  KARAFUN_UI_URL=http://<player-ip>:<port>   (local UI — clean)');
    log('boot', '  KARAFUN_UI_URL=https://www.karafun.com      (cloud UI — brittle)');
  }

  const proxy = httpProxy.createProxyServer({
    target: KARAFUN_UI_URL || 'http://127.0.0.1:1', // dummy => visible 502 until set
    changeOrigin: true,        // send upstream's Host
    ws: true,                  // proxy the realtime channel too
    autoRewrite: true,         // rewrite redirect Location host -> us
    cookieDomainRewrite: '',   // scope upstream cookies to our origin
    xfwd: true,
  });

  // Append our minted identity cookie to the upstream response.
  proxy.on('proxyRes', (proxyRes, req) => {
    if (req._kfMinted) {
      const prev = proxyRes.headers['set-cookie'] || [];
      proxyRes.headers['set-cookie'] = [].concat(prev, req._kfMinted);
    }
  });

  proxy.on('error', (err, req, res) => {
    log('proxy', `upstream error: ${err.message}`);
    if (res && res.writeHead && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('upstream (KARAFUN_UI_URL) unreachable');
    }
  });

  const app = express();

  // Identity + observe middleware — runs BEFORE proxying, never alters the body.
  app.use((req, res, next) => {
    const { fp, minted } = identify(req);
    if (minted) req._kfMinted = minted;
    const ip = req.socket.remoteAddress;
    store.ensure(fp, store.get(fp)?.name || `guest@${ip}`, ip);

    // GATING UNKNOWN: KaraFun web-UI request shapes. sniffWeb is best-effort.
    const sniff = kfadapter.sniffWeb(req.method, req.url);
    const who = `fp=${short(fp)}${minted ? '(new)' : ''} ip=${ip}`;
    if (sniff.kind === 'other') {
      log('proxy→', `${req.method} ${req.url}  (${who})`);
    } else {
      log('proxy→', `${req.method} ${req.url}  :: looks like ${sniff.kind}  (${who})`);
      if (sniff.kind === 'add') {
        // OBSERVE: we can attribute the add to fp now, but the song title/id
        // lives in the request body whose shape we haven't confirmed yet.
        if (OBSERVE) {
          log('WOULD', `attribute add to ${short(fp)} + reconcile (need body shape — see probe)`);
        } else {
          // LIVE (post-probe): parse body -> addSong(fp, title). Wired here.
          addSong(fp, sniff.title || null);
        }
      }
    }
    next();
  });

  app.use((req, res) => proxy.web(req, res));

  const httpServer = http.createServer(app);

  // Proxy WebSocket upgrades (KaraFun web UI realtime channel) to upstream.
  httpServer.on('upgrade', (req, socket, head) => {
    log('proxy', `ws upgrade ${req.url} -> upstream`);
    proxy.ws(req, socket, head);
  });

  httpServer.listen(GUEST_PORT, () => {
    log('boot', `MODE=proxy  OBSERVE=${OBSERVE ? 1 : 0}  weight=${WEIGHT}`);
    log('boot', `proxy in:    http://0.0.0.0:${GUEST_PORT}   <-- point your QR here`);
    log('boot', `upstream:    ${KARAFUN_UI_URL || '(UNSET — set KARAFUN_UI_URL)'}`);
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

function shutdown() {
  log('boot', 'shutting down, persisting store');
  store.persist(true);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { reconcile, currentOrder, addSong }; // exported for potential tests
