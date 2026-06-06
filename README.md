# KaraFun fair-share queue

A scheduler that sits in front of a KaraFun player and continuously reorders the
pending queue so **whoever has sung least goes next**. Nobody is blocked; the
order just keeps rebalancing. Identity is keyed on a device fingerprint, so a
guest can't jump the line by retyping their name.

## Status: OBSERVE MODE scaffold

This is built but **not yet wired to the live protocol**. It runs in observe
mode: it logs everything both directions and computes the order it *would*
apply, without mutating the player's queue. That's deliberate — the exact
KaraFun frame shapes are unconfirmed, and observe mode turns the first live run
into the experiment that confirms them.

### The one gating unknown
Everything hinges on whether this KaraFun version exposes the local control
socket on `ws://localhost:57570` and what its frames look like — specifically:
- does each queue entry carry a `singerName` / id?
- what frame signals a song finished, and does it say who/what?
- can the catalog be searched over the same socket?

Run the probe (`../karafun-probe.js`) **or** just run this server in observe
mode and point a phone at it — both surface the same answers. Send the logs
back and the `kfadapter.js` stubs get replaced with the real shapes, then flip
`OBSERVE=0`.

A second, complementary question — *which deployment framing is buildable* —
is answered by `../karafun-topology.js`: it discriminates whether a guest's
add via KaraFun's own QR enters over a **loopback** socket (A), a **LAN**
socket (B), or the **cloud** (C). A/B mean framings 1 or 2 are buildable; C
means only framing 1. See "Three deployment framings" below.

## Three deployment framings (same code)
1. **Our-own-QR proxy** — disable KaraFun's native remote; hand guests a QR
   pointing at this server. Works as long as the proxy↔player local link exists.
2. **Transparent loopback MITM** — bind on the port KaraFun's remotes expect,
   redirect the real player, and KaraFun's *own* QR keeps working through this
   server. Viable only if the guest-facing path is the local socket.
3. **Cloud MITM** — intercepting the app↔karafun.com link. **Not recommended:**
   TLS + likely cert pinning means installing a root CA on every guest phone,
   and it crosses into circumventing a third-party service. Avoid.

Framings 1 and 2 are the same listener; the only difference is where the QR
points. The probe decides which are buildable.

## Architecture
```
[guest phones] --ws--> [server.js] --ws--> [KaraFun player :57570]
                          |
        +-----------------+-----------------+
        |                 |                 |
   fairshare.js       store.js         kfadapter.js
   (ordering)      (identity +        (ONLY module that
                    play counts,       speaks KaraFun's
                    persisted)         wire protocol)
```
- **fairshare.js** — pure ordering. `score = played + weight*pendingAhead`,
  FIFO tie-break. No protocol coupling; unit-testable in isolation.
- **store.js** — fingerprint→{name, played}, in-memory + JSON snapshot, persists
  across the night.
- **kfadapter.js** — quarantines all KaraFun-specific parsing/sending. Stubbed,
  observe-mode. This is the file that changes after the probe.
- **server.js** — guest web + WebSocket, wires the three together, dual-logs.
- **public/index.html** — minimal guest page: fingerprint, join, search, add,
  live "your position" standing.

## Run
```
cd karafun-fairshare
npm install
npm run observe          # OBSERVE=1, safe, logs only
# point a phone on the same LAN at http://<this-machine-ip>:8080
# add songs, watch the console
```
Env: `PLAYER_URL` (default `ws://localhost:57570`), `GUEST_PORT` (8080),
`WEIGHT` (1.0), `OBSERVE` (1).

When the logs confirm the protocol, fill in `kfadapter.js`, then `npm run live`.

Dependencies: `express` (guest page) + `ws` (both WebSocket directions).

## Probe
```
cd karafun-fairshare
npm run probe                       # connects to ws://localhost:57570
# or, with a benign search frame:
node ../karafun-probe.js ws://localhost:57570 --search "your song"
```
The probe logs every frame both directions and pretty-prints JSON so the queue,
finished, and search shapes become obvious. Send the output back.

## Topology (which framing is buildable)
```
cd karafun-fairshare
npm run topology                    # probes loopback + LAN on candidate ports
# or, passing the machine LAN IP if auto-detect misses it:
node ../karafun-topology.js 192.168.1.50
```
Then add a song from KaraFun's *own* QR and watch whether it surfaces on a local
socket (loopback/LAN ⇒ framing 1 or 2) or not at all (cloud ⇒ framing 1 only).
The script prints the exact discrimination steps, including the `netstat`/`lsof`
line that separates loopback from LAN.

## Tests
```
cd karafun-fairshare
npm test                 # node:test unit tests for the pure ordering engine
```

## Known honest limits
- Fingerprint is forgeable by clearing browser storage. Fine for a party. For
  evasion-resistance, bind it server-side to a first-visit httpOnly token — see
  notes in `store.js`. Not built.
- Reorder strategy (native move vs remove+re-add) is unknown until the probe;
  `kfadapter.moveTo` has both paths sketched.
- Song-completion attribution depends on the finished-frame naming who sang.
  If it doesn't, we attribute via our own queue mapping instead — decided after
  we see the frame.
