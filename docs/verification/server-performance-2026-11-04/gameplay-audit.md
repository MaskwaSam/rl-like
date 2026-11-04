# Follow-up gameplay audit — 2026-11-04

Reviewed production source at `9564227cde9ff105ccdf9f852af53f73e7f71bb4` against
pre-pass baseline `0998166fba124cb4ea3fea87ecde2aa3c14ac0a0`.

No supported game-breaking regression was found in the reviewed changes or tested paths.
This follow-up changes tests and verification documentation only. No production code,
rendering, graphics settings, deployment, or server configuration was changed.

## Independent source review

A fresh Sol High reviewer examined input readiness/pacing, socket admission and stale
callbacks, reconnect ordering, worker transfer ownership, snapshot publication, and how
the simulation uses the reused input Map. It reported no introduced findings. It explicitly
recommended runtime probes for reconnects spanning match lifecycle changes and for
goal/overtime transitions during catch-up. The coordinator added and ran those probes.

## New permanent regression coverage

`qa/server-play.ts` now exercises these additional cases using actual ServerRoomSession and
ClientSession instances, real localhost HTTP/WebSockets, the room worker, and Rapier:

- End the match while a guest socket is disconnected. Its replacement returns to the lobby
  without resurrecting the previous prediction world.
- Start a new match while the guest is disconnected. It restores the same seat, adopts the
  new epoch, and starts exactly one prediction world.
- Disconnect the owner while the match is running. Other players continue receiving server
  snapshots; the returning owner restores its seat and ownership controls.
- Verify no initial or replacement socket sends gameplay packets before admission across
  all these lifecycle changes.

Both 1v1 and 4v4 passed all 22 scenario checks, including the existing driving, prediction,
RTT, frame-pause/resume, ordinary reconnect, rematch, finite render-state, and cleanup checks.

`qa/server-authority-scheduling.ts` now drives corresponding real baseline/candidate worlds
through 12-tick catch-up frames that cross kickoff release, scoring, post-goal kickoff,
overtime entry, overtime scoring, and final result publication. It explicitly checks emitted
score, scorer, phase, and final result, alongside exact serialized game and Rapier-world bytes.
The expanded suite passed 573 state comparisons across 572 advances and 783 physics ticks.

## Executed validation

All commands completed successfully on the integration checkout:

- `npm run build` and `npm run server:build`.
- `npm run test:server`, including input preflight, authority scheduling, worker queue
  ownership/backpressure, actual 1v1/4v4 sessions, and 95 private-room integration checks.
- `npm run test:headless`: 21 checks, including eight-car movement, scoring, slot reuse,
  demolition respawn, full rooms, and all four arenas' identical physics.
- `npm run test:modes`: 51 checks across 1v1, 2v2, 3v3, 4v4, goals, rematches, and start rules.
- `npm run test:sessions`: prediction, metadata, startup cancellation, clock recovery, and
  delayed/lossy authority driving.
- `npm run test:spectators`: spectator lifecycle, old-epoch rejection, and delayed/lossy play.
- `npm run test:lan`: 23 transport scenarios, 38 heartbeat scenarios, host snapshot scheduling,
  and spectator snapshot batching/lifecycle checks.
- `npm run test:retry`: 17 room/match/input-state checks.
- After adding the new cases: `npm run test:server-scheduling`, `npm run test:server-play`,
  and `npm run test:server-play:4v4` all passed again.
- Strict standalone TypeScript checking of both extended QA files and `git diff --check`.

## Acceptance limits

The real-server checks run on localhost with headless Node clients; the other session suites
use in-memory transports as labeled. Finite render transforms do not establish WebGL/browser
visual acceptance. This audit does not establish physical-device controller behavior,
cross-device Wi-Fi latency, browser background/sleep behavior, or production capacity.
Those remain distinct from the successful source, simulation, and local network checks.

The server performance release remains undeployed. The dirty Desktop root and its unrelated
work are preserved; tests and documentation are committed on the isolated integration branch.
