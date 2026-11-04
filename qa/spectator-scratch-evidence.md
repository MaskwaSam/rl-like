# Spectator scratch allocation evidence

Baseline: `29cebba`, loaded directly with `git show` by the Vite plugin in
`qa/run-spectator-scratch.mjs`. No baseline checkout or production changes.

Run: `node qa/run-spectator-scratch.mjs` (Node v26.5.1).

The runner instruments only spectator snapshot scratch map construction, scratch
body construction/copying, and the empty input map used by spectator stepping.
Exact source markers must exist or the runner fails. These counts exclude Game,
Rapier, decoding, rendering, iterators, offset creation, and the test harness;
they are not heap/GC measurements or latency measurements.

| Eight-car workload | Baseline scratch maps | Baseline step maps | Baseline bodies | Candidate targeted allocations | Body copies baseline / candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 same-tick corrections | 200 | 0 | 1800 | 0 | 1800 / 1800 |
| 100 corrections replaying two ticks | 200 | 200 | 1800 | 0 | 1800 / 900 |
| 100 newer-authority corrections | 200 | 0 | 1800 | 0 | 1800 / 0 |
| One correction exceeding replay cap | 2 | 30 | 18 | 0 | 18 / 0 |

Measurements follow scratch warm-up. Cold allocation for eight cars is two
scratch maps, one empty input map, and 18 bodies (two balls plus two per car).
Roster additions allocate missing scratch bodies on capture. Removed IDs are
pruned even on non-comparable corrections; end/start/leave clear both maps.
Ball scratch values are overwritten before use; none are lent to Game/renderers.

478 exact baseline comparisons passed. Each compares serialized game bytes,
current/previous interpolation snapshots, full car render states including
position/quaternion offsets, ball offset/visibility, events, readiness, alpha,
playback/arrival clocks, pending packets, and stepping statistics. Cases include
same-tick corrections, replay, exact 30-tick boundary and exceeded cap, small
corrections, teleports, goal-to-countdown and countdown-to-play transitions,
roster removal/re-addition (including capped replay and newer authority),
rematch with stale old-epoch packets, and 160 loss/burst/prediction frames.
Assertions also check cold allocation bounds, scratch roster bounds, no body
aliases with Game/current/previous render transforms, reset cleanup, and that
Game.step leaves the reusable input map empty.

Additional passing checks:

- `npm run test:spectator-batching`: packet coalescing, epoch/size validation,
  prediction/smoothing/effects, decode failure containment and lifecycle fences.
- `npm run test:spectators`: live diagnostic max tick lag 1, max position error
  0.003 m, one snapshot/frame; lossy diagnostic max tick lag 3, final error
  0.245 m, zero clock snaps. Includes capacity, version, rematch and departure.
- `npm run test:spectator-admission`: admission success/error/timeout cleanup.
- `npm run typecheck` and `git diff --check`.

The source changes preserve replay/extrapolation limits, physics-step counts,
batching, packet validation, deferred decode fencing and latency policy. All
runtime checks used local headless Rapier with mock transport. Actual browser,
physical LAN/device, GC and controller-to-photon behavior remain unmeasured.
