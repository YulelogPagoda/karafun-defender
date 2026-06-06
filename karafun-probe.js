#!/usr/bin/env node
'use strict';

// karafun-probe.js — standalone diagnostic. Pure observation; sends only the
// benign probe frames you opt into with --search.
//
// Purpose: confirm the ONE gating unknown — whether this KaraFun version exposes
// a local control socket on ws://localhost:57570, and what its frames look like:
//   1. Does each queue entry carry a singerName / id?
//   2. What frame signals a song finished, and does it name who/what?
//   3. Can the catalog be searched over the same socket?
//
// Run it, then sing a song / add to the queue / search from the KaraFun remote
// and watch what comes across. Send the logs back; they tell us how to fill in
// kfadapter.js.
//
// Usage:
//   node karafun-probe.js [ws-url] [--search "query"]
//   PLAYER_URL=ws://localhost:57570 node karafun-probe.js
//
// Note: `ws` is a dependency of the karafun-fairshare package. Run this via
// `npm run probe` from that folder, or `node ../karafun-probe.js` after install.

let WebSocket;
try {
  WebSocket = require('./karafun-fairshare/node_modules/ws');
} catch (_) {
  try {
    WebSocket = require('ws');
  } catch (_) {
    console.error('Cannot find the `ws` module. Run `npm install` in karafun-fairshare/ first.');
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const urlArg = args.find((a) => !a.startsWith('--'));
const URL = urlArg || process.env.PLAYER_URL || 'ws://localhost:57570';
const searchIdx = args.indexOf('--search');
const searchQuery = searchIdx !== -1 ? args[searchIdx + 1] : null;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (tag, ...a) => console.log(`${ts()} ${tag}`, ...a);

log('probe', `connecting to ${URL}`);
log('probe', 'now interact with KaraFun (add a song, sing one, search) and watch below');

let ws;
try {
  ws = new WebSocket(URL);
} catch (err) {
  console.error(`could not open ${URL}: ${err.message}`);
  process.exit(1);
}

ws.on('open', () => {
  log('open', 'connected — control socket EXISTS at this URL');
  if (searchQuery) {
    // Optional, opt-in probe frame. Shape is a guess; harmless if ignored.
    const frame = JSON.stringify({ action: 'search', query: searchQuery });
    log('send', frame);
    ws.send(frame);
  }
});

ws.on('message', (data) => {
  const text = data.toString();
  log('recv', text);
  // Pretty-print JSON when possible to make queue/finished shapes obvious.
  try {
    const obj = JSON.parse(text);
    console.log(JSON.stringify(obj, null, 2));
  } catch (_) {
    /* non-JSON frame — the raw line above is what matters */
  }
});

ws.on('error', (err) => {
  log('error', err.message);
  log('hint', `no player on ${URL}? Confirm KaraFun is running and exposes the local socket.`);
});

ws.on('close', (code, reason) => {
  log('close', `code=${code} reason=${reason || '(none)'}`);
  process.exit(0);
});

process.on('SIGINT', () => {
  log('probe', 'closing');
  try { ws.close(); } catch (_) {}
  process.exit(0);
});
