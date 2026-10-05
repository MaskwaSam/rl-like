# Car Soccer deployment — September 30, 2026

Public URL: https://car.spatterson.ca/

Deployed source commit: `d2fea702f2a5ee327889141487476ba5512a65de`.
Release: `20260930-d2fea702f2a5`.
Image: `car-soccer:20260930-d2fea702f2a5-ec92d5c7f3fc`.
Archive SHA-256: `ec92d5c7f3fc15aa624c1ce654249464b0ca359016c2502caf5f75d7adbaa7b9`.

## Confirmed

- Production container healthy on SPN100. Dedicated internal network
  `car_soccer_edge` contains exactly `car-soccer` and `spatterson-cloudflared`.
- UID 101, read-only filesystem, all capabilities dropped, no new privileges,
  no host-published ports, 128 MiB memory, 0.5 CPU and 64 PID limits.
- NGINX configuration and Compose validation passed. The isolated candidate
  served every packaged file with its expected hash. The exact connector network
  namespace reached `http://car-soccer:8080/healthz` and its release identity.
- Cloudflare reported successful Published application route creation and
  automatically created the `car` CNAME. The path field is blank. Only this route
  was added to the existing `spatterson-site` Tunnel.
- Public HTTPS with full certificate verification returned the expected game
  markup, 22 exact file hashes, `/healthz` 200, expected cache headers and four
  missing/private-path 404s. Cloudflare sometimes adds the zone's existing Web
  Analytics beacon to HTML; the underlying game markup matched after removing
  only that known script. No zone-wide settings were changed.
- Exact deployed build tested in a loopback browser preview: menu identity
  `v0.1.0 · d2fea70 · 2026-09-30 15:49`, free-play arena/car rendered at 60 fps.
  Its connection test reported direct, STUN, configured relay and reachable relay
  all yes. No claim of a completed cross-network match is made.
- All 17 prior SPN100 container identities, images, start times and restart
  counts unchanged; prior networks preserved. The connector gained only
  `car_soccer_edge` and was not restarted.
- Public GETs for apex, www, Bible, Cree, Draw, SNES and FLEX passed HTTP 200 with
  valid TLS; www finished at apex. Python urllib HEAD probes received 403 from
  the edge, while normal curl GETs passed. Both shared Moodle names returned
  valid-TLS 303 login redirects through the unchanged LAN edge.
- No tunnel token, account API secret, TLS key or SMTP material was read,
  copied or printed. The game's existing intentionally browser-readable TURN
  file is served at `/turn.json`; its values were kept out of verification logs.
  No server-side player data or persistent game volume was introduced.
- Read-only Sol deployment reviewer found no actionable configuration findings.

## Current limitation

The home router at `192.168.1.254` still returned cached NXDOMAIN for the new
hostname during browser verification. Authoritative Cloudflare DNS and 1.1.1.1
returned its proxied A records, and SPN100 resolved and reached the public URL.
Mac public-file checks used the returned Cloudflare address `104.21.58.24`,
retaining the original hostname and full TLS verification. Chrome and the in-app
browser's normal public navigation remained blocked by this local DNS cache.
A final router DNS reply showed 810 seconds remaining on its negative cache (about 14 minutes at that check). No router or system DNS settings were changed. Public-domain browser gameplay,
actual cross-network multiplayer, controller/device coverage and host reboot
remain separate acceptance gates. PeerJS and TURN remain external dependencies.

## Retained release and rollback

SPN100 root: `/home/sam/services/car-soccer`.
Source, static build and deployment configuration archive:
`releases/20260930-d2fea702f2a5.tar.gz`.
Verified extracted snapshot: `releases/20260930-d2fea702f2a5/`.
Before-state: `rollback/before.json` and `rollback/provider-before.json`.
Receipts: `receipts/origin-20260930-d2fea702f2a5.json`,
`receipts/neighbor-acceptance.json`, `receipts/public-acceptance.json`.

For initial rollback, remove only the Cloudflare `car.spatterson.ca` Published
application route and its managed `car` CNAME. Then disconnect only
`car_soccer_edge` from `spatterson-cloudflared` and stop only `car-soccer` using
the exact commands in `deploy/README.md`. Keep the package and image for recovery.
There was no previous Car Soccer deployment to overwrite; neighboring releases
are the retained unchanged rollback baseline. No backup/restore of player data
is needed because the server serves static files only.

## References consulted

- [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)
- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)
- [Docker Compose networks](https://docs.docker.com/reference/compose-file/networks/)
