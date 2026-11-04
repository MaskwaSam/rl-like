# Ribbon point reuse evidence

Baseline: `c57fd439b5d89cab43e384c5f43ef7aeba23588b:src/render/effects.ts`.

Implementation keeps the existing newest-first array and rendering math. At capacity,
it resets and reuses the oldest point. Expiry and clear move points to a private
free list. New points/vectors are created only when neither list supplies one.
The pool grows lazily to the maximum occupancy and remains available after clear.

Checks:

- `node qa/ribbon-reuse.mjs`: passed, 52,387 differential comparisons.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

The regression reads the actual baseline with `git show`, builds baseline and
candidate through Vite, and uses actual Three.js Mesh, BufferGeometry and Vector3
objects. It compares complete position/color arrays (including unused tails),
indices, draw ranges, visibility, attribute versions, newest-first positions and
ages after every add, update and clear. Cases cover motion, stationary emission,
variable dt, fade/expiry, exact lifetime and strictly greater expiry, repeated
clear/reuse, capacity wrap, camera movement, collinear side fallback, threshold
boundaries, and caller mutation of the emitter vector. Capacities 0, 1, 2, 10 and
16 are checked; the baseline's unusual zero-capacity single-point behavior is
preserved.

The fixture instruments just the executed TrailPoint object literal and its
owned vector creation expression in each source, preserving the actual Three
operations. For **each** production configuration (16-point ball and 10-point
boost), after filling capacity:

- Baseline over 10,000 moving frames: 10,000 TrailPoints + 10,000 Vector3s.
- Candidate over 10,000 moving frames: 0 TrailPoints + 0 Vector3s.
- Candidate over another 100 alternating clear/expiry/refill cycles: 0 of either.

Retained target cost is bounded at one point/vector pair per maximum concurrent
point: 16 pairs per ball ribbon, 10 pairs per boost ribbon, plus one free-list
array per ribbon. Allocation is lazy; active and free lists share these pairs
without duplicates. This trades retaining expired points for avoiding repeated
allocation. Engine array capacity/heap bytes and unrelated runtime allocations
were not measured. This is CPU geometry/state equivalence, not rendered visual,
GPU, frame-time, or whole-runtime zero-allocation acceptance. The parent owns
rendered A/B validation. Dependencies used the authorized ignored node_modules
symlink to the spectator-mode deployment installation; no package/CI changes.
