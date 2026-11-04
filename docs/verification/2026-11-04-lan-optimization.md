# LAN performance optimization — 2026-11-04

Runtime source: `141fc88` (base `616a764`). [Recorded evidence](2026-11-04-lan-optimization.json) includes exact source hashes, workload counts and browser results.

The changes remove avoidable send scheduling delays and repeated snapshot processing without changing the wire protocol, physics frequency, spectator update frequency or graphics quality.

## Changes

- Fast-channel failure detection now requires repeated observations in separate event-loop turns. Scheduling gaps reset confirmation; close/replacement cancels and fences the monitor. A genuinely blocked queue still retires to the reliable fallback.
- A drained channel admits one input/snapshot plus one exact five-byte ping/pong, in either order. Repeated calls and partial drain cannot replenish that allowance. PeerJS's reliable queue remains a hard gate; reliable controls invalidate pairing credit.
- The host sends the newest player state once after simulation catch-up. Players retain their acknowledgement headers and nominal 60 Hz snapshot budget. Spectators keep their per-update delivery and match-epoch headers. Both streams share one state serialization when due together.
- Spectators retain only the newest eligible raw snapshot before the next update. Epoch and tick checks precede decoding; fixed-layout validation protects usable pending state from truncated replacements. Arrival timestamps, immediate initial readiness and end/rematch cleanup are preserved. Deferred decoding failures cannot abort the frame loop.
- Unchanged spectator HUD values are no longer rewritten each frame. Boost-pad scaling reuses a vector. Graphics defaults and shadow quality are unchanged.

## Deterministic results

In an eight-player/eight-viewer workload at 60 host updates per second, state serializations fell from 240 to 120 over two simulated seconds. Viewer packet count and payload volume stayed unchanged.

A six-snapshot burst between draws now requires one decode/application instead of six. Repeated stale packets require zero decodes instead of six.

For controlled 33.3, 50 and 100 ms host updates, sent player snapshots now contain the final simulated tick. This removes the previously measured 16.7, 33.3 and 83.3 ms of additional state age **before network travel**. These update durations are a controlled probe, not measured browser FPS; background-worker scheduling is outside that probe.

## Validation

- 23 transport scenarios, including real-stall recovery, same-task pauses, timer cleanup and heartbeat/watchdog interaction.
- 38 heartbeat admission scenarios across fast and reliable channels, bounded buffering, send failures and controls.
- Host scheduling tests cover newest ticks, per-player acknowledgements, epochs, cadence and serialization reuse.
- Spectator batching tests cover startup, stale packets, every truncation of actual zero-to-eight-car snapshots, corrupt counts, deferred decode failure, prediction, smoothing, effects, goal metadata, no-input behavior and rematch cleanup.
- Existing session, spectator, startup, admission and retry suites passed. All 23 spectator-host access checks passed. Client/server builds and typecheck passed; the existing large-bundle warning remains.
- All 42 final browser checks passed with real PeerJS/WebRTC on one Mac. The intentional 300 ms task pause did not retire the fast channel. The final spectator had zero fallback submissions and zero stall recoveries. Camera switching, rotation, touch reveal, goals, rematches and departure passed.

The initial screenshot-enabled software-WebGL run stalled at the free-camera movement assertion while both pages reported zero FPS. The final behavior run disabled drawing/screenshots. It therefore does not establish rendering performance, visual acceptance, physical LAN latency or multi-device compatibility.

## Review and limits

Independent Sol review found two integration issues, both repaired locally: speculative pre-correction physics added work and could invent collision effects, and malformed packets could replace valid pending snapshots. Regression coverage now checks both. No speculative effects catch-up remains; existing forward prediction and correction replay provide transient effects. The snapshot protocol still does not carry an authoritative collision-event history.

Four implementation worktrees were retained. Worker commits were integrated with a targeted transport merge; the final integration also includes the review repairs and CI wiring. `npm run test:lan` runs the four dedicated LAN suites and is included in CI.

Next acceptance is a comparison on two physical LAN devices, including several viewers, frame-time tails, selected ICE path, queue/recovery counters and synchronized screen capture. No physical-device speedup percentage is claimed. This change publishes source only; it does not change the live deployment or infrastructure.
