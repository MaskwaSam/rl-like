# LAN performance production release — November 4, 2026

The performance changes are deployed to both `https://car.spatterson.ca` and `https://carspectator.spatterson.ca`. Runtime source is `0c08548aa55b1f0436d40116067e3f96dd3f3dcc`; its game code matches the reviewed optimization source `ee2b0a1`, with the release helper refreshed for the existing spectator deployment.

Release: `20261104-spectator-0c08548aa55b`.
Image: `sha256:4ed93221ba65e03b0971cd9090d46e8a42e91cb8b7b69cbac4cc159c3c0a2a35`.
Acceptance time: `2026-11-04T21:01:09Z`.
The [machine-readable receipt](release.json) records exact source, image, container, packet and operator identities.

## Changes and acceptance

- All LAN scheduling, snapshot batching, allocation, renderer-update and trail-buffer optimizations are included. Graphics settings and simulation frequency are unchanged.
- Fresh `test:lan`, `test:hotpaths`, `test:spectators`, client/server builds and all 12 release-helper tests passed. Independent Sol review found no release-helper findings. Prior runtime evidence includes 43 local WebRTC browser checks and 19 pixel-identical rendered comparisons; see [visual evidence](../2026-11-04-render-visual.md).
- The immutable packet's archive, manifest, source inventory and built bytes were verified locally and during remote extraction. The Linux candidate built without external networking or dependency installation. Exact candidate runtime files, configuration, base layers, synthetic authentication, protected assets and room boundaries passed before activation.
- Authenticated room metrics immediately before cutover reported zero server rooms and zero server connections; the probe logged out. These metrics do not enumerate browser-hosted PeerJS rooms.
- Only Car Soccer was recreated. It is healthy with zero restarts. All 50 neighboring containers, including the Cloudflare connector, retained their recorded state. Compose content, authentication-file metadata, config permissions/ACLs, security settings and resource limits were preserved. Only the `CAR_RELEASE` setting changed. No DNS, Tunnel, firewall or storage changes were made.
- Public HTTPS checks through Cloudflare confirmed the new release on both origins. Existing-password login passed; ten JS/CSS/image assets per origin matched packaged hashes. HTML pointed to the expected entry script; HTML bytes are not compared because Cloudflare injects its analytics script. Anonymous protected assets were denied, spectator management/metrics endpoints were denied, and both probe grants were revoked through logout.
- The shared browser independently displayed the normal login gates and read the new release identity, healthy status and anonymous access state from both origins. The two check tabs were closed; the existing Cloudflare tab was preserved.

Public authenticated HTTPS checks ran from SPN100 using ordinary certificate verification. This Mac's command-line DNS returned Fortiguard's blocked-page address and certificate; the shared browser reached the origins normally. No certificate bypass, DNS override or firewall exception was used. A Python default user-agent received HTTP 403; the HTTPS verifier used a normal browser user-agent. All public comparisons completed successfully before and after cutover.

## Recovery

Retained previous release: `20261104-spectator-8c9a197033bc`.
Previous image: `sha256:41b3fe3554c10515b739d76f00357fb088485a2ec153cdfc690480e4dbfddcf4`.
New rollback record:
`/home/sam/services/car-soccer/rollback/20261104T205851Z-20261104-spectator-0c08548aa55b/record.json`.

The current config pair, backup hashes, baseline image, authentication metadata and fresh neighbor snapshot passed read-only rollback preconditions. The earlier spectator release's recovery records remain untouched. No rollback was executed. Recovery refuses subsequent unknown config, image, authentication or neighbor drift and resets in-memory rooms/sessions.

Pinned Car-only rollback command, for an explicitly requested recovery:

```sh
ssh sam@spn100 python3 -I /home/sam/services/car-soccer/release-tools/20261104-spectator-0c08548aa55b/release_operator.py rollback 20261104-spectator-0c08548aa55b da111051f616e6b049931ee6afdb494f892ae3544afaa1936559b39ef8d7be10 --expected-operator-sha256 73f867f788cc8bd4f4100e904b73305ff8ee4955810cf3989a1d3b61984c7ce2 --allow-session-reset
```

The protected packet and staging records remain in `.deployment/lan-performance-20261104/` locally and the matching `releases/` / `release-tools/` directories on SPN100. No cleanup was performed. The dirty Desktop main checkout and separate issue worktrees were preserved.

## Limits

This release check did not conduct a new authenticated live multiplayer match or physical-device test. Prior local simulation, WebRTC and rendered checks remain distinct from production load, Safari/mobile/controller, continuous-animation and two-device LAN/FPS acceptance. No physical latency or FPS improvement percentage is claimed. Available host disk at acceptance was 6,572,896,256 bytes; storage cleanup was outside scope.
