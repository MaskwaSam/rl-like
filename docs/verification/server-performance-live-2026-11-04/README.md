# Dedicated-server performance production release — November 4, 2026

Deployed to https://car.spatterson.ca and https://carspectator.spatterson.ca.
Runtime source: `8edc0ab27dcba26b33ca761c7cb624469fff0aea`. Game code matches the reviewed `ba12efc`
audit; the final source commit refreshes the four release helpers.

Release: `20261104-spectator-8edc0ab27dcb`.
Image: `sha256:29a22c8721c5b5df5bd0569fa492b20098aba27781ba897219bab8b90a00451c`.
Accepted: `2026-11-04T22:01:49Z`.
The [release receipt](release.json) records source, image, container, packet,
operator and rollback identities.

## Verified results

- Fresh client/server builds and 13 release-helper tests passed. Independent Sol
  review found no actionable release-helper findings. The preceding
  [gameplay audit](../server-performance-2026-11-04/gameplay-audit.md) records the
  broader simulation, reconnect, 1v1/4v4 and gameplay-transition regressions.
- The immutable packet, source/output inventories and exact hashes were checked
  locally and during remote staging. The Linux candidate built without external
  networking or dependency installation. Its exact files, runtime configuration,
  base layers, synthetic login, assets and room boundaries passed before activation.
- Authenticated metrics immediately before activation showed zero server rooms
  and zero connections. Those metrics do not enumerate browser-hosted PeerJS rooms.
- Only Car Soccer was recreated. It is healthy with zero restarts. All 50 recorded
  neighboring containers, including the Cloudflare connector, remained unchanged.
  Compose bytes, authentication-file metadata, security settings, resource limits
  and config permissions/ACLs were preserved. Only the release setting changed.
  No DNS, Tunnel, firewall or storage cleanup was performed.
- Public HTTPS checks before and after activation used normal certificate
  verification from SPN100. Both origins returned the expected release identity;
  existing-password login, expected HTML entry, ten exact asset hashes per origin,
  anonymous asset denial, spectator API/metrics restrictions and logout revocation
  passed. The probe did not bypass TLS or override DNS.
- A temporary live 1v1 room admitted an owner and invite guest using protocol v3.
  Both reached play, received advancing snapshots and input acknowledgments,
  and adopted a new matching epoch/countdown after rematch. Each observed 64
  additional ticks and 32 snapshots during the input check. The probe closed only
  its own room, confirmed zero remaining rooms/connections, logged out both grants
  and verified unauthenticated status. No test room remains.

The live match probe ran raw Node clients over HTTP/WebSocket inside the production
container. It exercises the deployed admission/worker/authority path, not browser
prediction or public WSS transport. Public HTTPS acceptance is a separate check.
The source suites cover actual ClientSession prediction on localhost. No new
physical LAN, browser-rendering, mobile/controller, Wi-Fi, production-capacity or
FPS benchmark is claimed. This release changes no graphics settings or visuals.

## Recovery

Previous release: `20261104-spectator-0c08548aa55b`.
Previous image: `sha256:4ed93221ba65e03b0971cd9090d46e8a42e91cb8b7b69cbac4cc159c3c0a2a35`.
Rollback record: `/home/sam/services/car-soccer/rollback/20261104T215944Z-20261104-spectator-8edc0ab27dcb/record.json`.

Backup hashes, both config states, baseline image, authentication metadata and the
fresh neighbor snapshot passed read-only rollback preconditions. No rollback was
executed. Recovery refuses unknown drift and resets ephemeral rooms/sessions.
The pinned, Car-only rollback command for an explicitly requested recovery is:

```sh
ssh sam@spn100 python3 -I /home/sam/services/car-soccer/release-tools/20261104-spectator-8edc0ab27dcb/release_operator.py rollback 20261104-spectator-8edc0ab27dcb 67b0325f54cea1b66d9abdce25f79277ac4fa662551c1ee0d2cea1ad661df86a --expected-operator-sha256 24438d42391042a3e0a2058bb0a11c74a408a87cb78e94735cd0c6a3763a3110 --allow-session-reset
```

Protected packet, probe sources and staging evidence are retained locally in
`.deployment/server-performance-20261104/` and in the matching remote `releases/`,
`release-tools/`, `receipts/` and `rollback/` locations. The private password input
file was removed after acceptance; password values, cookies and invites are absent
from the receipt. Available host disk at acceptance was 6,518,202,368 bytes.
The dirty Desktop main checkout and separate issue worktrees were preserved.

## Next LAN work

The [next LAN review](../lan-next-pass-2026-11-04/README.md) recommends reducing
input-list allocation first, then pooling prediction history and preflighting LAN
congestion before encoding. These proposals are not part of this deployed release.
