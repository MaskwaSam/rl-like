# Five spectator edge-case fixes

Runtime and test source verified: `7593099`, on `spectator-edge-fixes-integration`,
based on `spectator-mode` at `db442ef`. The final documentation commit changes no runtime code.

All five issues were implemented in separate T3-managed worktrees and integrated with
cherry-picks. The five worktrees and their branches are retained and clean.

## Worktrees and commits

All worktree paths below are under `/Users/sam/.t3/worktrees/Car Soccer/`.

| Issue | Branch | Worktree | Issue head | Integrated commits |
| --- | --- | --- | --- | --- |
| Touch overlay recovery | `t3/spectator-touch-reveal` | `t3-b12155c2` | `4fd2945` | `0ddfd07` |
| Chase-camera resize | `t3/spectator-resize-projection` | `t3-5b2ca82e` | `1ad2066` | `4be260e` |
| Terminal connection cleanup | `t3/terminal-link-shutdown` | `t3-6df0a66f` | `48f5fae` | `39df57d` |
| Host startup retry | `t3/host-startup-retry` | `t3-2942a66a` | `9669b9c` | `1b3de74` |
| Admission disconnect | `t3/spectator-admission-settlement` | `t3-23c565d1` | `f8cce6f` | `6be3b1b`, `d80e7f7` |

The admission worktree contains its main repair and a follow-up that places the admission
helper in `src/net/`, keeping production imports independent of QA files. Combined test wiring,
browser regressions, and operator documentation are in coordinator commit `7593099`.

## Resulting behavior

- Hide leaves a small accessible **Show controls** button. Touch viewers can restore controls
  without a keyboard or controller; their selected view is preserved. The button disappears
  on match end and room departure. H and controller toggles continue to work.
- Player views retain their configured horizontal FOV through window resizing and rotation.
  Overview and free cameras retain control of their own projections.
- Terminal Link events close the reliable connection and fast channel once, notify once,
  and fence late packets/channels. The existing terminal-disconnect policy is preserved;
  this does not implement reconnect or host migration. Send queues remain bounded.
- Failed host startup releases the startup lock, propagates the error, cleans a partial
  candidate, and permits retry. Concurrent Start requests remain guarded. Leaving during
  asynchronous creation cannot resurrect a match, and unsuccessful starts do not advance epochs.
- A terminal event during spectator admission rejects promptly with the actual reason and
  cancels the timer. Explicit host rejection and genuine timeout retain their own messages.
  Duplicate settlement and synchronous send failures are handled without leaking resources.

## Validation on the integrated source

- `npm run build` and `npm run server:build`: passed. Client build retains the existing
  large-bundle warning.
- `npm run test:host-startup`: five failure/concurrency/cleanup scenarios passed.
- `npm run test:spectator-admission`: 13 checks passed for success, early close/error,
  rejection, timeout, late welcome, and synchronous send failure.
- `npm run test:transport`: 17 scenarios passed, including terminal event repetition,
  paired closure, late dispatch, close failures, and existing queue/fallback behavior.
- `npm run test:spectators`: passed, retaining epoch isolation, capacity, rematch, departure,
  and delayed/lossy checks. Deterministic driving max lag 1 tick, max position error 0.003 m;
  delayed/lossy max lag 3 ticks. These are simulation checks, not physical latency measurements.
- `npm run test:sessions`, `npm run test:retry` (17), `npm run test:headless` (21),
  `npm run test:modes` (51), `npm run test:private` (95), and
  `npm run test:spectator-host` (23): passed.
- `qa/spectator-browser.mjs`: 39 checks passed with real PeerJS signalling/WebRTC between
  Chromium contexts on one Mac, including a touch-enabled phone viewport. Player horizontal
  FOV remained 110 degrees through landscape/portrait/landscape rotation. Touch Hide/Show
  restored controls and retained view; reveal visibility cleared at end/departure.
  No uncaught page errors. Report: `2026-11-04-spectator-edge-fixes-browser.json`.
- Independent GPT-6.1 Sol high review of the combined diff found no actionable new defects;
  its transport regression also passed. Three Luna workers and two Sol workers implemented
  the isolated fixes at Standard speed.
- New startup and admission suites are wired into package scripts and CI. CI itself has not
  run remotely because this work has not been pushed.

Run the browser harness as described in `server/README.md`; raw local screenshots and report
are in `.qa-build/spectator-browser/` under the integration worktree. Most drawing is suppressed
in the harness to avoid software WebGL starving the simulation. It is not an FPS benchmark.

## Acceptance limits and deployment boundary

Fake transport tests establish lifecycle behavior, not a physical one-sided Wi-Fi failure.
A Chromium touch context establishes touch-event/UI behavior, not physical iOS/Android acceptance.
Separate physical LAN devices, controller operation, actual pointer-lock interaction, audible output,
hardware frame rates, and a production rollout remain unverified. No production service, DNS,
container, secret, or remote Git reference was changed. The dirty Desktop main checkout was preserved.
