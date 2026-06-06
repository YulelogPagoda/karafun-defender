'use strict';

// server.js — wires the three modules together and dual-logs everything.
//
//   [guest phones] --ws--> [server.js] --ws--> [KaraFun player :57570]
//                              |
//                fairshare (order) + store (identity/plays) + kfadapter (wire)
//
// OBSERVE MODE (default): compute the order we *would* apply and LOG it; never
// mutate the player's queue. Flip OBSERVE=0 only after kfadapter's stubs are
// confirmed against real frames.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const fairshare = require('./fairshare');
const kfadapter = require('./kfadapter');
const { Store } = require('./store');

// ---- config ---------------------------------------------------------------
const PLAYER_URL = process.env.PLAYER_URL || 'ws://localhost:57570';
const GUEST_PORT = parseInt(process.env.GUEST_PORT || '8080', 10);
const WEIGHT = parseFloat(process.env.WEIGHT || '1.0');
const OBSERVE = process.env.OBSERVE !== '0'; // default ON (safe)
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- state ----------------------------------------------------------------
const store = new Store().load();
let seqCounter = 0;
/** @type {Array<{id:number, fp:string, seq:number, title:string, singerName:string}>} */
let pending = [];
/** guest socket -> { fp } */
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
  const ordered = currentOrder();
  const summary = ordered.map((e, i) => `${i + 1}.${e.singerName}:${e.title}`);
  log('ORDER', `(${reason})`, summary.join('  ') || '(empty)');

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

// ---- guest websocket server ----------------------------------------------
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
      const rec = store.get(meta.fp);
      const entry = {
        id: ++seqCounter, // doubles as a stable per-night id and FIFO seq source
        fp: meta.fp,
        seq: seqCounter,
        title,
        singerName: rec ? rec.name : 'guest',
      };
      pending.push(entry);
      send(ws, { type: 'added', id: entry.id, title });
      reconcile(`add ${entry.singerName}:${title}`);
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
    log('player→', data.toString());
    const evt = kfadapter.parseInbound(data);

    // GATING UNKNOWN #2: song-finished attribution.
    const fin = kfadapter.detectFinished(evt.json || {});
    if (fin) {
      attributeFinish(fin);
    }
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

// ---- http (serve guest page) + ws server ----------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

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

// ---- lifecycle ------------------------------------------------------------
httpServer.listen(GUEST_PORT, () => {
  log('boot', `OBSERVE=${OBSERVE ? 1 : 0}  weight=${WEIGHT}`);
  log('boot', `guest page:  http://localhost:${GUEST_PORT}`);
  log('boot', `player url:  ${PLAYER_URL}`);
  if (OBSERVE) log('boot', 'observe mode — nothing will be sent to the player');
  connectPlayer();
});

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

module.exports = { reconcile, currentOrder }; // exported for potential tests
