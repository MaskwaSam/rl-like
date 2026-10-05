# car.spatterson.ca

Static browser game on SPN100. Game state and controls stay in browsers; the
hosting player's browser owns multiplayer matches. PeerJS signalling and the
existing browser-readable TURN configuration are external dependencies.

Production root: `/home/sam/services/car-soccer`. Origin:
`http://car-soccer:8080`. The existing `spatterson-cloudflared` connector shares
the dedicated internal `car_soccer_edge` network with this service. Docker
persists that attachment across container and host restarts; recreating the
connector requires reattaching every currently accepted app network, including
this one, without dropping any existing attachment.

The production Compose file publishes no host ports, has no persistent volumes,
and runs NGINX as UID 101 with a read-only root and bounded resources and logs.
Cloudflare terminates public HTTPS. No new certificates or router changes are
required. There is no server-side game data to back up. Retain checksum-bound
release packages, Git source archives, image identifiers and deployment receipts.

## Release procedure

1. Inspect source and live state. Build from the reviewed source commit using
   `npm ci` and `npm run build`; record any deliberate local changes.
2. Export the source commit and package its `dist/` with this deployment folder,
   a public `release.json`, and SHA-256 checksums. Exclude `.git`, dependencies,
   logs and all private credentials. `turn.json` is intentionally downloaded by
   browsers and must contain only client relay credentials, never an account API
   secret. Do not print its values in deployment logs.
3. Upload to a new `releases/<release>/` directory and verify checksums. Pin the
   official NGINX base to its registry digest; build an immutable image tag.
4. Validate NGINX and Compose; probe the candidate on a disposable internal
   network, then remove only that probe and its disposable network.
5. For updates, save the live `.env` and Compose configuration in a timestamped
   rollback directory before replacing them. Keep the prior image and package.
6. Recreate only `car-soccer` with the exact Compose path. Connect the existing
   connector to `car_soccer_edge` only if not already attached. Do not recreate
   the connector. Prove the exact origin from its network context before cutover.
7. Add or retain the single Published application route `car.spatterson.ca`,
   blank path, `http://car-soccer:8080` on the `spatterson-site` Tunnel. Let
   Cloudflare create its managed proxied CNAME. Preserve neighboring routes.
8. Verify public HTTPS, `/healthz`, `/release.json`, all asset hashes, cache
   behavior, missing-file 404s and actual browser free play. Test multiplayer
   separately and record precisely what passed. Compare neighbor identities,
   start times, restart counts and network attachments with the before-state.

## Rollback of initial deployment

Remove only the `car.spatterson.ca` Published application route and its managed
`car` CNAME in Cloudflare. Then on SPN100:

```sh
docker network disconnect car_soccer_edge spatterson-cloudflared
docker compose --project-name car-soccer \
  --env-file /home/sam/services/car-soccer/.env \
  -f /home/sam/services/car-soccer/compose.yaml stop car-soccer
```

Retain the service directory, archived source and image for recovery. Never run
`compose down`, broad network removals, Docker prune or Tunnel resets. Updates
roll back only this service to its retained prior image/configuration, with
internal and public verification repeated afterwards.
