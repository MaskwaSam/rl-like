# Dedicated server performance pass — 2026-11-04

This pass reduces avoidable work in dedicated server hosting and server-connected player
sessions. Baseline: `0998166fba124cb4ea3fea87ecde2aa3c14ac0a0`. Production was not changed.

The subsequent [gameplay audit](gameplay-audit.md) records broader validation and added
regressions for reconnects spanning match changes and goal/overtime catch-up transitions.

## Changes

- Clients skip pending-input selection and encoding while the socket is unavailable,
  backpressured, awaiting admission, or comfortably before its next send deadline. A 1 ms
  preparation allowance avoids unnecessarily postponing near-deadline input; the final send
  gate retains the exact 60 Hz cap. WebRTC links without the optional hook retain their path.
- The server performs all required physics ticks before capturing one latest snapshot when
  a snapshot boundary was crossed. Intermediate catch-up states are no longer encoded and
  queued. Normal 120 Hz physics and 60 Hz snapshot opportunities are preserved. No connected
  players means no snapshot serialization.
- The authority reuses and clears its input Map instead of allocating one every tick.
- Incoming WebSocket payloads are copied into owned storage, then transferred to the worker.
  This removes a structured-clone payload copy without detaching a pooled WebSocket Buffer.
- A real-session test exposed a reconnect admission race. Initial and replacement sockets
  now wait for welcome before sending inputs or pings; callbacks from old sockets cannot
  change the replacement's admission state.

Source commits: `1d1e9ef`, `b789a8b`, `02f2e04`, `80b2407`, `8fa6a96`.
Real-session QA was integrated in `de7dd00` and extended in `8fa6a96`.

## Measurements and acceptance

[Machine-readable counts](measurements.json), [chart](work-counts.html),
[chart image](work-counts.png).

The input benchmark compiles the actual baseline and candidate methods, runs deterministic
two-second prediction sequences, and compares packet bytes, timestamps, pending inputs and
physics tick counts. At simulated 120 FPS, encodes were 240 before and 159 after; at 240 FPS,
479 before and 161 after. Transmitted packets and prediction ticks matched in these fixtures.
The blocked scenario went from 41 encodes to zero. A separate advancing-clock case covers
preparation crossing a send deadline. These fixtures do not establish arbitrary wall-clock
or garbage-collection trace equivalence.

The authority benchmark compiles the historical implementation independently and uses real
Rapier worlds. All 566 game/world byte comparisons matched across 565 advances and 699 physics
ticks, including disconnects, removed/reused slots, epochs, rematches, asynchronous startup
cancellation and backlog handling. A 12-tick catch-up with two recipients went from six state
captures and twelve encodes to one capture and two encodes. Steady cadence was unchanged.

Passed locally on the integrated source:

- `npm run build` and `npm run server:build` (includes application/server typechecks).
- `npm run test:sessions`: prediction, metadata, startup, clock recovery and delayed play.
- `npm run test:server-inputs`: differential packets and work counts, pacing boundaries,
  backpressure, admission, reconnects, stale callbacks, epochs and absent-hook fallback.
- `npm run test:server-scheduling`: exact game/Rapier comparisons and scheduling counts.
- `npm run test:server-queues`: ten real worker/IPC checks, including deliberately withheld
  output ACKs, continued physics, control priority, input ownership transfer and connection
  fencing. This is worker backpressure coverage, not a saturated network benchmark.
- `npm run test:server-play` and `npm run test:server-play:4v4`: seventeen checks each using
  actual ServerRoomSession/ClientSession, localhost HTTP/WebSockets and worker physics.
  Movement is confirmed by authoritative snapshots. Tests cover alternating 120/240 Hz
  frame targets with real elapsed time, RTT, paused frames, same-session reconnect, rematch,
  finite render states and clean room destruction. These targets are not measured FPS.
- `npm run test:private`: 95 real HTTP/WebSocket/worker checks covering 1v1 through 4v4,
  authorization, invites, all arena choices, input validation and room lifecycle.

`npm run test:server` aggregates the dedicated-server suites. CI runs it after both builds.
The QA shares a Node realm for clients and initializes Rapier before creating their worlds;
real browser tabs naturally own separate module instances. No render code, assets, graphics
settings or simulation algorithms changed. No new WebGL screenshots were taken in this pass.
Physical LAN latency, browser frame pacing and SPN100 CPU/capacity remain unmeasured here.

## Review and worktrees

A Luna mapper traced the server/IPC path. Sol workers implemented the input preflight,
authority scheduling and real-session QA in separate retained worktrees:

| Responsibility | Branch | Worktree |
| --- | --- | --- |
| Input preflight | `t3/server-input-pacing` | `/Users/sam/.t3/worktrees/Car Soccer/t3-79dfc993` |
| Authority scheduling | `t3/defer-authority-snapshots` | `/Users/sam/.t3/worktrees/Car Soccer/t3-db4055b0` |
| Actual player-session QA | `t3/server-session-headless-qa` | `/Users/sam/.t3/worktrees/Car Soccer/t3-65088b42` |

The coordinator integrated, added IPC/queue checks, fixed the timing and admission edges,
and ran the integrated checks. A separate Sol High review found no supported introduced
issues in `0998166..80b2407`; the final admission fix received its own focused review.
Reviews are source/QA inspections, separate from the executed integration tests.

The dirty Desktop root remains on `d2fea70` with its original unrelated changes. The previous
production release remains `20261104-spectator-0c08548aa55b`; deployment helpers are pinned to
that earlier release and must be deliberately refreshed before any future deployment.
