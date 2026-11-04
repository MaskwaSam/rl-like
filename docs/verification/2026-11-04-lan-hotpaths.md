# LAN hot-path optimization — 2026-11-04

Runtime source: `4638119`, following the first LAN optimization at `29cebba`. The simulation frequency, network protocol, snapshot cadence, prediction limits and graphics quality are unchanged.

## Changes and measured work

- **Wheel friction:** each car reuses two fixed four-vector buffers. All wheel impulses are still calculated before any are applied, in the same order. The two eight-car scenarios eliminated 16,036 temporary arrays and 63,562 vectors at the targeted sites. All 1,440 complete snapshots, ordered impulses and diagnostics matched the baseline byte-for-byte/exactly. Initial storage costs two arrays and eight vectors per car. [Detailed evidence](../../qa/car-friction-evidence.md).
- **Spectator corrections:** private maps and body buffers are reused, and capture is skipped when a correction cannot return to the displayed tick. The empty prediction input map is reused. After warm-up, 100 eight-car same-tick corrections allocate zero targeted scratch maps/bodies instead of 200 maps and 1,800 bodies. Two-tick replay copies nine bodies rather than eighteen per correction. All 478 differential comparisons matched, including offsets, clocks, events, rematches and roster changes. [Detailed evidence](../../qa/spectator-scratch-evidence.md).
- **Boost pads:** ring colours and their buffer attributes change only when active state changes. The three-pad fixture went from three colour writes and two colour-attribute version increments per steady frame to zero. Orb animation still updates every frame. Replacement layouts release instanced buffers, geometry and owned materials, preserving the shared glow texture. Fixed layouts avoid a per-frame coordinate scan.
- **Nameplates:** follow/overview switches hide and reuse the existing sprite and texture. Renames redraw the same canvas; actual removal releases the owned texture/material without disposing shared sprite geometry. The actual baseline and candidate renderer methods created 50 versus one canvas/texture across 100 alternating views.

These counts cover the named source allocation sites and Three.js update/disposal events. They exclude other simulation allocations, Rapier internals, decoder allocations and test instrumentation. They do not measure GC pauses, GPU memory reclaimed, rendered FPS or controller-to-photon latency.

## Verification

`npm run test:hotpaths` runs the four new checks. Differential runners read the pinned baseline directly through Git/Vite, so CI fetches history. No baseline checkout is created. The suite is part of CI alongside the existing LAN regressions.

Integrated checks passed: client/server builds (including TypeScript), all hot-path suites, LAN transport/heartbeat/snapshot/batching regressions, session and spectator suites, 21 headless checks and 51 mode/start-rule checks. The existing bundle-size warning remains.

The real PeerJS/WebRTC browser run passed all 43 checks, including nameplate reuse during camera switching, portrait FOV, touch reveal controls, rematch cleanup and host departure. It used three browser contexts on one Mac with drawing and screenshots suppressed; it does not establish physical LAN latency or rendered FPS.

Independent Sol review found no P-level findings in the integrated changes. It checked scratch ownership, stale wheel slots, comparability/replay gates, reset/pruning, pad resource ownership and nameplate visibility/disposal. Browser results and exact runtime hashes are recorded in [the companion JSON evidence](2026-11-04-lan-hotpaths.json).

Four issue worktrees were retained. The dirty main checkout was preserved. This is a source update only; live deployment and infrastructure are unchanged. Physical LAN devices and rendered frame-time/GC measurements remain the next acceptance step.
