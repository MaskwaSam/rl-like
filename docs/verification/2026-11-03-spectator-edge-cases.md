# Spectator edge-case review and repair

Reviewed baseline: `4f5afa8` on `spectator-mode`, based on main `0e6f8d0`.
Production was not accessed or changed. The dirty Desktop checkout was preserved.

## Findings repaired

- **P2: stale packets could poison a rematch.** A delayed tick-12000 snapshot from an old
  match was accepted after end/start, causing new tick-2 snapshots to be rejected until
  the new match caught up. Independent Sol review reproduced this against the baseline.
  `src/net/host.ts` now sends a monotonic spectator match epoch in start controls and the
  otherwise unused input-acknowledgement header. `src/net/spectator.ts:214` checks that epoch
  before decoding or buffering. Player packet semantics are unchanged. Regressions inject
  old packets across asynchronous startup and after new synchronization, and prove fresh
  snapshots continue advancing. Short pong packets are also ignored safely.
- **P2: audio could continue after leaving.** The render loop stops updating sound when
  there is no active game, leaving the prior engine/boost gains in place. Spectator screen
  transitions now mute sound outside a live match; background tabs mute too. First pointer
  or keyboard interaction resumes audio after automatic room-link entry.
- **P2: camera mode changes during a goal pause could follow the hidden ball.** A new chase
  camera or ball-cam toggle bypassed the entry-only goal override. Effective ball cam is now
  derived each frame from the viewer preference and goal phase. Changes made during the
  pause remain the preference after kickoff.
- **P3: stale UI caches.** Rebuilding player buttons left unchanged boost values blank, and
  ball-cam changes did not invalidate the highlight cache. Both caches now track their DOM
  lifecycle. Match startup resets countdown/banner and sound edges. Leaving the match
  restores overlay visibility and closes help. Leaving free cam releases pointer lock.
  Hidden-feed mode also hides help. Duplicate join submissions are ignored while connecting.

## Verification

- Client build/typecheck and server build passed.
- Spectator simulation regression passed: 1 tick maximum lag and 0.003 m maximum position
  error in deterministic driving; delayed/jittered/lossy test max lag 3 ticks, final error
  0.263 m. These are model checks, not physical latency measurements.
- Spectator hostname HTTP/WebSocket checks: 23 passed, including blocked room APIs,
  cross-origin login rejection, separate sessions, and preserved game WebSockets.
- Session, Retry (17 cases), transport (8 scenarios), headless (21), modes (51),
  and private-room integration (95) regressions passed.
- Expanded built-app browser harness: 28 checks passed over real PeerJS/WebRTC using two
  Chromium contexts on one Mac, plus a phone viewport. Included boost labels after camera
  switching, both ball-cam button states, goal-pause camera switching/preferences, overlay
  reset, and a fresh countdown after rematch. Browser tick comparisons are estimates of simulation display time, not camera-to-photon latency.
  Software rendering was mostly suppressed, so these are not frame-rate measurements.
- Harness source: `qa/spectator-browser.mjs`. Local report and screenshots:
  `.qa-build/spectator-browser/`. See `server/README.md` for prerequisites and invocation.

## Limits

The independent reviewer covered state lifecycle, host read-only handling and existing
transport bounds, and found no additional supported defect in those reviewed boundaries.
This is not exhaustive security acceptance. Physical LAN devices, controller operation,
actual pointer-lock interaction, audible output, and hardware frame rates remain unverified.
Audio, visibility, duplicate-submit and pointer-lock repairs have source/build coverage;
the browser harness does not claim those physical or audible checks.

No push, rollout, DNS change, container restart or production activation was performed.
