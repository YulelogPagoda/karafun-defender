#!/usr/bin/env node
'use strict';

// karafun-topology.js — deployment-framing discriminator.
// ============================================================================
// Answers the ONE question that decides which MITM framing is buildable:
//
//   When a guest adds a song via KaraFun's OWN QR/remote, WHERE does that add
//   enter? Three possible worlds:
//
//     (A) LOOPBACK — remote talks to the player on 127.0.0.1:<port>.
//                    MITM lives ON THE PC (intercept loopback).
//     (B) LAN      — remote talks to the player's LAN IP:<port>.
//                    MITM lives ON THE NETWORK (redirect that port).
//     (C) CLOUD    — add goes phone -> karafun.com -> pushed to the player over
//                    its cloud link. No local entry point exists; local MITM is
//                    impossible — use the our-own-QR framing (framing 1) instead.
//
// This maps directly onto the README's three framings:
//   A/B => framing 1 or 2 are buildable; C => only framing 1.
//
// HOW IT WORKS
//   1. Tries to CONNECT OUT to candidate control-socket ports on both loopback
//      and the machine's LAN IP(s), and reports which answer + what they emit.
//      (Confirms the API surface we'd drive the queue through.)
//   2. Acts as an OBSERVER: for any socket that answers, it subscribes and logs
//      frames, so when you then add a song via KaraFun's QR you can SEE whether
//      that add surfaces on the local socket (=> A or B) or not (=> C).
//
// It can't itself sniff arbitrary inbound TCP (that's what netstat / Wireshark
// are for — see PRINTED INSTRUCTIONS at the end), but combined with a 30-second
// netstat it fully disambiguates A/B/C.
//
// RUN (on the KaraFun PC):
//     cd karafun-fairshare && npm install      # provides the `ws` dependency
//     npm run topology
//   or, passing the machine LAN IP if auto-detect misses it:
//     node ../karafun-topology.js 192.168.1.50
// ============================================================================

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

const os = require('os');

const CANDIDATE_PORTS = [57570, 57571, 8000, 8080, 50050];
const stamp = () => new Date().toISOString().split('T')[1].replace('Z', '');

// This machine's primary LAN IPv4 address(es).
function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const argIP = process.argv[2];
const hosts = ['127.0.0.1', ...(argIP ? [argIP] : lanIPs())];

console.log('='.repeat(64));
console.log('KaraFun topology discriminator');
console.log('hosts to probe:', hosts.join(', ') || '(none found)');
console.log('ports to probe:', CANDIDATE_PORTS.join(', '));
console.log('='.repeat(64));

const liveSockets = [];

function tryConnect(host, port) {
  return new Promise((resolve) => {
    const url = `ws://${host}:${port}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      return resolve({ url, alive: false });
    }
    let settled = false;
    const done = (alive) => { if (!settled) { settled = true; resolve({ url, alive }); } };

    const to = setTimeout(() => { try { ws.terminate(); } catch (_) {} done(false); }, 2500);

    ws.on('open', () => {
      clearTimeout(to);
      console.log(`[${stamp()}] OPEN  ${url}`);
      liveSockets.push(ws);
      // poke for status so we start receiving frames (both common shapes)
      try { ws.send('getStatus'); } catch (_) {}
      try { ws.send(JSON.stringify({ action: 'getStatus' })); } catch (_) {}
      ws.on('message', (d) => {
        const raw = d.toString();
        console.log(`[${stamp()}] <- ${url}  (${raw.length}b): ${raw.slice(0, 600)}`);
      });
      done(true);
    });
    ws.on('error', () => { clearTimeout(to); done(false); });
  });
}

(async () => {
  for (const host of hosts) {
    for (const port of CANDIDATE_PORTS) {
      const r = await tryConnect(host, port);
      if (!r.alive) console.log(`[${stamp()}] .  no answer  ${r.url}`);
    }
  }

  console.log('\n' + '='.repeat(64));
  if (liveSockets.length === 0) {
    console.log('No local control socket answered on any host/port tried.');
    console.log('-> Strongly suggests WORLD (C): the remote path is cloud-mediated,');
    console.log('   OR the player is not running / uses a port not in the list.');
    console.log('   Verify the player is running, then widen CANDIDATE_PORTS.');
  } else {
    console.log(`${liveSockets.length} live control socket(s). The API surface EXISTS.`);
    console.log('Now run the DISCRIMINATION STEP below.');
  }
  console.log('='.repeat(64));

  console.log(`
DISCRIMINATION STEP - figure out A vs B vs C
--------------------------------------------
This script is now LISTENING on any live socket above. Do this:

  1. Leave this running.
  2. On a PHONE, scan KaraFun's QR (the native remote) and ADD A SONG through
     KaraFun's own remote.
  3. Watch this console:
       - A frame appears showing your song -> the add transits the LOCAL control
         socket. You're in WORLD A or B (framing 1 or 2 buildable).
       - NOTHING appears here but the song shows on the player -> the add came via
         the CLOUD. WORLD C. Local MITM not possible; use framing 1 (our-own-QR).

  4. To tell A (loopback) from B (LAN), in a SECOND terminal run (swap in the
     port that answered):
         netstat -ano | findstr 57570        (Windows)
         lsof -nP -iTCP:57570 -sTCP:ESTABLISHED   (macOS/Linux)
     Look at the phone's connection:
       - 127.0.0.1 on both ends -> A (loopback-only binding)
       - player LAN IP <-> phone LAN IP -> B (LAN). MITM = redirect that port on
         the network / host firewall to this proxy.

Send back: which URLs went OPEN, the frames printed when you added via QR, and
the netstat/lsof line for the phone's connection. That nails the topology.
`);

  setInterval(() => {}, 1 << 30); // keep listening
})();

process.on('SIGINT', () => { console.log('\nstopped.'); process.exit(0); });
