# LAN startup and synchronization update

Source baseline: the checksum-verified source archive for live release
`20261003T224415Z-9bd5cb33108a` (source commit `9bd5cb33108aa6b559c77256a88b6c1012506415`).
The older Desktop checkout is preserved separately.

The client previously copied metadata from an older authoritative snapshot into a
newer predicted game whenever car and ball positions matched. This rewound the
countdown while leaving rigid-body freeze state on a different timeline. The
client now compares metadata at the historical snapshot tick and preserves its
newer prediction only when both agree. Divergence still restores and replays the
authoritative state. Boost and pad cooldowns are checked with their serialization
precision accounted for.

Startup retains the newest snapshot while physics loads and enables play after
initial synchronization. Every match clears its input, clock and smoothing state.
LAN/browser rooms remain the primary multiplayer option; server rooms retain the
existing optional toggle. Automatic direct WebRTC with relay fallback is retained.
Gameplay sends wait for transport queues to drain instead of accumulating stale
updates; reliable control messages retain their existing path.

Prediction now accounts for the full round trip from an already delayed snapshot
to the returning input, with a bounded recent-RTT jitter allowance. Clock recovery
does not depend on a successful input acknowledgement, so a player whose initial
inputs all arrive late can recover. Falling latency drains the lead gradually
without rewinding into input ticks already queued at the authority.
The first ping is sent immediately so a fresh low-latency LAN connection does not
remain on the conservative, unmeasured 100 ms estimate.

## Verification

- Client/server builds and TypeScript checks.
- 21 simulation/session checks and 51 checks covering 1v1 through 4v4.
- 95 private-room integration checks using real localhost HTTP/WebSockets and
  physics workers, with temporary test credentials.
- Focused regressions for historical countdown, active pad cooldown through
  expiry, movement after neutral kickoff, delayed startup and end during startup.
- Five mocked-channel transport regression scenarios.
- Independent review reproduced the old countdown failure and verified its fix.
- Deterministic 300 ms round-trip delay, jitter and 20% packet-loss startup test,
  plus a high-latency-to-LAN contraction regression.
- Eight-player real PeerJS/WebRTC browser suite: all 20 checks passed on one Mac,
  including input movement, rejoin, reset and a smaller rematch. Seven clients
  reported 2-5 ms ping in that passing run.

Use `npm run test:sessions` and `npm run test:transport` for the added regressions.
The in-memory headless/mode suites use a virtual simulation clock so workstation
scheduling stalls do not turn into fictional network RTT; their clock/input
assertions are unchanged. Actual WebRTC and delayed/lossy tests remain separate.
Real-browser evidence is recorded separately with the release package. Tests on
one Mac do not establish performance between separate devices on the user's LAN.

Deployment must preserve the accepted runtime, password mount, Compose settings,
network and neighboring services. Retain the previous immutable image and a
configuration checkpoint. Restarting the service clears its in-memory rooms and
login sessions; obtain the operator's quiet-restart decision before activation.
