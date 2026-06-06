# KaraFun fair-share queue

A scheduler that sits in front of a KaraFun player and continuously reorders the
pending queue so **whoever has sung least goes next**. Nobody is blocked; the
order just keeps rebalancing. Identity is keyed on a device fingerprint, so a
guest can't jump the line by retyping their name.

## Quick start

**Only prerequisite: [Node.js](https://nodejs.org) 18 or newer.** Then, from a
clone of this repo:

```sh
cd karafun-fairshare
npm install      # one time — installs express + ws + http-proxy
npm start        # safe OBSERVE mode: logs only, never touches the player
```

That's the whole install. Now:

- **Operator dashboard:** open **http://localhost:8080/__admin**
- **Guests:** point a phone on the same Wi-Fi at **http://&lt;this-machine-ip&gt;:8080**

Add a few songs and watch the order rebalance in the dashboard. Nothing is sent
to the player in this mode — it only logs the order it *would* apply.

To check what the script names are at any time: `npm run`. The ones you'll use:

| Command | What it does |
|---|---|
| `npm start` | Run in OBSERVE mode (safe default — logs only) |
| `npm test` | Run the unit tests |
| `npm run probe` | Probe the KaraFun control socket (venue setup) |
| `npm run topology` | Find which deployment framing is buildable (venue setup) |
| `npm run proxy` | Reverse-proxy mode (needs `KARAFUN_UI_URL`) |
| `npm run live` | Go live — actually reorders (only after the probe) |

Everything below is detail you don't need to get started.

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

See [Quick start](#quick-start) for first-time install. `npm start` (= `npm run
observe`) runs the safe, log-only mode. Configuration is all via environment
variables:

| Env var | Default | Meaning |
|---|---|---|
| `OBSERVE` | `1` | `1` = log only; `0` = actually reorder (after the probe) |
| `MODE` | `page` | `page` = serve our own UI; `proxy` = reverse-proxy KaraFun's UI |
| `PLAYER_URL` | `ws://localhost:57570` | KaraFun control socket we reorder over |
| `GUEST_PORT` | `8080` | Port for the guest page / proxy (use `80` for a bare-IP QR) |
| `WEIGHT` | `1.0` | Stacking penalty per song a singer already has queued |
| `KARAFUN_UI_URL` | — | Upstream KaraFun web UI (required in proxy mode) |
| `COOKIE_NAME` | `kffp` | Name of the server-pinned identity cookie (proxy mode) |
| `ADMIN_TOKEN` | — | If set, the dashboard requires `?t=<token>` |

When the logs confirm the protocol, fill in `kfadapter.js`, then `npm run live`.

### Proxy mode (`MODE=proxy`) — framing 1/2
Instead of serving our own page, reverse-proxy KaraFun's *own* web UI through
this box so the QR points at us and guests get KaraFun's interface, while we
fingerprint each session server-side and reorder out-of-band:
```
cd karafun-fairshare
# point upstream at whatever the probe revealed:
KARAFUN_UI_URL=http://<player-ip>:<port> npm run proxy   # OBSERVE=1, MODE=proxy
# guests scan a QR for  http://<this-box-ip>/   (use GUEST_PORT=80 for a bare URL)
```
- Guests talk **plain HTTP to us** (our origin) — no forged cert, no CA install,
  no HSTS issue. We talk to `KARAFUN_UI_URL` as an ordinary client.
- Identity is a server-minted **httpOnly token** cookie + source IP, pinned in
  `store.js`. A guest can't forge a fresh identity by editing a field — this is
  the evasion-resistant binding (only wired in proxy mode, where we own the
  responses).
- Reordering still goes over the **player control link** (`PLAYER_URL` →
  `kfadapter`), independent of how guests add. In observe mode we proxy +
  fingerprint + log only; bodies are never altered and the queue isn't touched.
- Extra env: `KARAFUN_UI_URL` (upstream, required), `COOKIE_NAME` (`kffp`),
  `ADMIN_TOKEN` (optional; gates the dashboard).

Which upstream is clean vs brittle (local player UI vs karafun.com cloud) is the
World-L-vs-C question `npm run topology` answers.

#### Attribution in proxy mode
Guests add via KaraFun's UI, so the song lands in *KaraFun's* queue, not ours.
We bind each queue row to a fingerprint with `correlate.js`: the proxied add is
recorded with its fingerprint + time, and when the queue frame echoes the new
row we attach it to the closest recent add (preferring a `singerName` the
protocol gives us, else timing). That mapping drives both the reorder target and
the play-count attribution when the song finishes.

### Operator dashboard
Both modes serve a monitor at **`/__admin`** (e.g. `http://localhost:8080/__admin`):
the fair-share order with score breakdown, the people table (play counts + last
IP), and a **Reset stats** button. It updates **live over WebSocket** — the
server pushes fresh state on every change (add, finish, reset, player
connect/disconnect), no polling. Reset zeros everyone's play count —
early in the night, before there are enough people to need fairness, reset so
order falls back to first-come and early arrivers keep singing. Set `ADMIN_TOKEN`
to require `?t=<token>` on the dashboard.

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
