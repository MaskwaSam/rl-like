# Render preservation and trail reuse — 2026-11-04

No visual regression was found in the tested frames. All 19 actual WebGL before/after captures were pixel-identical, and their PNG SHA-256 hashes also matched. This covers the previous pad/nameplate optimizations and the new Ribbon point reuse.

## Optimization

Ribbon now reuses its oldest point at capacity and retains expired/cleared points in a bounded free list. Point ordering, age reset, movement threshold, trail geometry, colors, lifetime, bloom, shadows and graphics settings are unchanged. Storage grows lazily to at most 16 point/vector pairs for the ball trail or 10 for each boost trail, plus one free-list array per ribbon.

The differential test against `c57fd439b5d89cab43e384c5f43ef7aeba23588b` passed 52,387 comparisons of positions, colors, indices, draw ranges, visibility, dirty versions, ordering, ages and ownership. Each production trail configuration eliminated 10,000 point objects and 10,000 vectors over 10,000 warmed moving frames. A further 100 clear/expiry/refill cycles required no target allocations. This measures the named allocation sites, not all allocations, GC pauses, FPS or LAN latency.

## Rendered check

The local QA page loads the actual historical `renderer.ts` and `effects.ts` from `29cebbaf055d7e8bdd010c0e975a31afad19c527` beside current source. Other dependencies are shared; there are no intervening changes to other render modules. Both sides receive identical seeded initialization, poses, camera, frame steps and settings. The harness draws real WebGL frames, rejects lost/error/blank contexts, compares every RGBA byte and saves both PNGs. It does not lower graphics quality to force a match.

The 19 cases cover low/medium/high quality; day, night, indoor and Maskwa venues; broadcast/full-field and fixed close/free angles; landscape 960×600 and portrait 600×960; pad pickup/respawn; followed/returned/renamed labels; demolition/respawn; a goal explosion; early/middle/full/faded trails. The close angles are deterministic renderer fixtures, not a live chase-camera/controller test. Browser: T3's shared Chromium 152 / Electron 44 on macOS.

Final independent Sol review found no material runtime or harness findings, inspected four final before/after image pairs, and verified all 19 saved PNG pairs byte-identical. An initial Terra visual review also found no mismatch; after correcting test-fixture team values, the final captures were reviewed by Sol and the parent. Parent inspection additionally covered portrait framing and effects. [Saved comparison image](2026-11-04-render-comparison.png). [Raw results, hashes and allocation evidence](2026-11-04-render-visual.json).

These are selected rendered frames, not a continuous animation or live network recording. Intermediate CPU trail geometry is covered by the differential suite. Other browsers/GPUs, physical LAN devices, long-running play and frame-time improvements remain unmeasured. Do not interpret Three.js last-pass counters or cumulative fixture resource counts as performance benchmarks.

## Repeat the check

1. Run `npm run qa:visual` from this checkout. It binds only `127.0.0.1:5189`.
2. Open `http://127.0.0.1:5189/qa/render-visual.html` and select case buttons. Each result includes `passed` and `differentPixels`; captures and JSON are saved in `.qa-build/render-visual/`.
3. To run the complete set in the browser console: `for (let i = 0; i < visualQA.cases.length; i++) await visualQA.run(i)`.
4. Run `npm run test:ribbons` for geometry/allocation regression. It is also included in `test:hotpaths` and the existing CI job. Git history is required for both pinned baselines.

Client build (including TypeScript), separate QA fixture typecheck, Ribbon regression, pad updates and nameplate regressions passed. The existing large-bundle warning remains. This source change does not deploy the game or alter infrastructure. The implementation worktree is retained, and dirty main is preserved.
