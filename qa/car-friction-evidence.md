# Wheel-friction allocation check

Baseline: `29cebbaf055d7e8bdd010c0e975a31afad19c527`.
Run: `node qa/car-friction-runner.mjs`.
The Vite plugin loads baseline car/game via `git show` and the candidate from this
workspace, sharing the unchanged simulation dependencies. Output is isolated in
`.qa-build/car-friction`. No checkout or package changes are needed.

Before editing car.ts, the same runner with
`CAR_FRICTION_EXPECT_BASELINE=1` confirmed both implementations had identical
allocation counts and trajectories. After editing, the default run passed:

| Measured site/event | Baseline | Candidate |
| --- | ---: | ---: |
| Friction calls | 8,018 | 8,018 |
| Contact wheels processed | 31,781 | 31,781 |
| Temporary impulse/point arrays | 16,036 | 0 |
| Temporary impulse/point Vector3 instances | 63,562 | 0 |

Counters are inserted directly at the production method's allocation sites in
QA builds only. Counts exclude test instrumentation, other simulation allocations,
Rapier internals and the unchanged object literals passed to applyImpulseAtPoint.
The replacement adds two arrays and eight vectors once per car (16 arrays and
64 vectors for these eight-car worlds), retained for that car's lifetime.
At four-wheel contact this removes two arrays and eight vectors per car tick.
No FPS, wall-clock speedup or GC-pause claim is made.

Two 720-tick, eight-car scenarios compare each tick's complete serialized game
snapshot byte-for-byte, plus exact ordered friction impulse/application-point
numbers and per-car diagnostics. Inputs exercise straight driving, steering,
boost, powerslide, reverse braking, coasting, jumps, air control, tilted partial
contacts, landing and an explicitly triggered demolition with timed respawn.
The contact histogram for 0/1/2/3/4 wheels is 3502/45/67/22/7884 car-ticks;
there are 36 zero-to-contact transitions and 30 demolished-car ticks.
All 1,440 snapshots match, as do every recorded impulse and diagnostic.
The fixture asserts every contact count is reached. These are representative
headless scenarios, not exhaustive native gameplay or real LAN acceptance.

The packed scratch prefix is fully overwritten before application. The second
pass visits only this tick's contact count, preserving wheel order, pre-impulse
calculation semantics and excluding stale slots after contact loss or respawn.
Scratch is neither serialized nor restored and is private to each car.

Additional validation: `npm run typecheck`, `npm run test:headless` (21 checks),
`npm run test:modes` (51 checks), and `git diff --check` passed.
Dependencies used the authorized ignored symlink to
`/Users/sam/Desktop/Car Soccer/.deployment/spectator-mode/node_modules`.
No browser, physical device, real WebRTC, deployment or timing benchmark was run.
