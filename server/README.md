# Private server rooms

The Node service serves the password page and authenticated game assets and owns one ephemeral
room (2/4/6/8 humans). Each room runs the existing Rapier Game in its own worker at 120 physics
ticks and 60 snapshots per second. All browsers use the existing ClientSession prediction and
input code; browser hosting/free play remain available after password login.

## Local development

Use Node 24 or newer. Run `npm ci`, `npm run build`, and `npm run server:build`.
Set `CAR_ORIGIN=http://127.0.0.1:4100` and start with `npm run server:start` to serve the built
app on port 4100. For Vite development, use origin `http://127.0.0.1:5173`, start the same
backend on 4100 and `npm run dev` in a second terminal; Vite proxies `/game` and WebSockets.

Generate the password hash locally with `npm run --silent password:hash`; entry is hidden.
Use a password of 12–256 characters. Never use the real password as a shell argument, source
literal, build variable or chat message. The resulting salted scrypt hash is also private.
Supply it through `CAR_PASSWORD_HASH_FILE` pointing to a private file, or `CAR_PASSWORD_HASH`
in a local test environment. The service fails closed when no valid hash is configured.
Do not commit password/hash files. Production password entry and protected file permissions
are a separate operator handoff before an approved deployment.

## Access and room lifetime

Password access lasts eight hours. HTTP-only, SameSite=Strict cookies are also Secure on HTTPS.
Password holders can use the app and create a room; owner authority belongs to that creator's
server-generated session identity, not to slot zero or a name supplied by a client.

Room codes contain eight unambiguous cryptographically random characters. Code joining requires
password access. A shared root URL `/#join=<192-bit-token>` redeems a separate room capability.
Guests need no password; their admission permits that room's WebSocket only, not room creation,
code lookup, other rooms or owner actions. There is no public room list. Invite tokens are not
stored in browser storage or HTTP URL paths/queries and must not be included in access/error
logs or analytics. Rotation changes the code/link and revokes/disconnects invite-only guests.

An active room includes the lobby and running match. Rooms have a 30-minute hard lifetime,
five-minute inactive lobby limit, 60-second empty-room cleanup, and 30-second reconnect seat
grace. `CAR_ROOM_TTL_SECONDS` can shorten lifetime for tests (2–1800, default 1800). The owner
can end/rematch/close; a match continues when their browser closes. A restart loses in-memory
rooms and invalidates invites; ask for a fresh room rather than silently changing authority.

Opening another tab reuses the same authenticated seat. The previous tab shows a gate message
without deleting the shared admission. Explicit leave and logout remove authority and admission.

## Limits and validation

One room maximum until measured SPN100 capacity justifies increasing it. Global and per-address
authentication/admission limits, two concurrent password checks and 128 grants bound entry work.
The WebSocket checks exact Origin/Host and a valid scoped cookie before upgrade. Control packets
are capped at 4 KiB and 10/s; inputs at 120 messages/s, 32 input records and 202 bytes including
epoch. Worker input queues are credit-limited. Outputs have one in-flight message per player,
16 queued controls and a coalesced newest snapshot. Slow sockets never block room physics.
Old match epochs are dropped. Tick windows, signed axes and defined controller flags are checked;
clients submit inputs only. Controls go neutral after 250ms without current input. Heartbeats
and reconnects are bounded. No tokens, cookies, passwords or player names are logged.

`/healthz` is a basic public health check. `/game/metrics` requires password access and returns
aggregate room/connection counts and simulation counters, without invite/player identifiers.
Hashed assets cache privately after admission; the small gate entry caches publicly. HTML and
API responses use no-store and no-referrer. Optional external analytics on the published hostname
must be reviewed for the invite flow before rollout; do not assume existing injection is safe.

## Verification and deployment boundary

Run `npm run build`, `npm run server:build`, `npm run test:headless`, `npm run test:modes`, and
`npm run test:private`. Private tests use real localhost HTTP/WebSockets and worker physics with
ephemeral random test passwords, never production credentials. The desktop/mobile Playwright
checks and screenshots are outside the repository in the workspace evidence folder.

`Dockerfile` pins the official Node 24 Alpine manifest digest read from Docker Registry on
October 2, 2026. `compose.example.yml` is a review-only recipe: retain the existing internal edge
network and origin port 8080, with no host ports or DNS/Tunnel changes. It replaces the static
Car Soccer runtime only; it does not operate other services. Proposed initial budget is one CPU,
512 MiB RAM and bounded logs. These are bounds, not a measured eight-player capacity promise.

No container build or server rollout has been run. SPN100 storage recovery is owned separately;
do not stage files/build images there until current headroom is verified and coordinated.
Preserve the accepted 4140197 image, configuration and rollback receipt. Before activation:
prepare a hash privately, validate file readability as UID 101 without exposing the value,
stage the candidate, test HTTPS/WSS and adversarial access with separate clients, and verify
neighbors/resources. Request action-time approval for activating production authentication.
Rollback restores the prior immutable image and configuration; it loses new in-memory rooms.
No storage offload, prune, resize or application-data movement is part of this refactor.
